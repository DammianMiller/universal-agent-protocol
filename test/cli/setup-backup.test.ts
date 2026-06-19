import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { backupInstructionFiles } from '../../src/cli/setup-backup.js';

describe('backupInstructionFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-backup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('backs up present instruction files under .uap-backups/<date>/', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# c');
    writeFileSync(join(dir, '.uap.json'), '{}');
    const r = backupInstructionFiles(dir);
    expect(r.backedUp).toEqual(expect.arrayContaining(['CLAUDE.md', '.uap.json']));
    expect(existsSync(join(dir, '.uap-backups', r.date, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, '.uap-backups', r.date, '.uap.json'))).toBe(true);
  });

  it('lists missing files in skipped without throwing', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# c');
    const r = backupInstructionFiles(dir);
    expect(r.backedUp).toContain('CLAUDE.md');
    expect(r.skipped).toContain('AGENTS.md'); // not present
  });

  it('is idempotent — a second run keeps the original backup bytes', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'original');
    const r1 = backupInstructionFiles(dir);
    const backupPath = join(dir, '.uap-backups', r1.date, 'CLAUDE.md');
    // Age the backup so a re-copy would change mtime, and mutate the source.
    const past = new Date(Date.now() - 60_000);
    utimesSync(backupPath, past, past);
    const before = statSync(backupPath).mtimeMs;
    writeFileSync(join(dir, 'CLAUDE.md'), 'CHANGED');

    backupInstructionFiles(dir);
    expect(statSync(backupPath).mtimeMs).toBe(before); // not overwritten
    expect(readFileSync(backupPath, 'utf-8')).toBe('original'); // original preserved
  });
});

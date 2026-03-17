# Mandatory File Backup Before Work

All files that will be modified during a session MUST be backed up before any changes are made. This is a non-negotiable safety requirement.

## Rules

1. **Backup before first edit.** Before modifying any file, create a timestamped backup copy in `.uap-backups/YYYY-MM-DD/` relative to the project root. The backup must be an exact copy of the original file.
   - Backup path: `.uap-backups/YYYY-MM-DD/original-path/filename`
   - Example: editing `src/index.ts` creates `.uap-backups/2026-03-15/src/index.ts`
   - If the backup already exists for today, skip (idempotent)

2. **Backup entire directory for bulk operations.** When performing operations that affect multiple files (refactoring, renaming, restructuring), backup the entire parent directory before starting.

3. **Never modify backups.** The `.uap-backups/` directory is append-only. Never modify or delete backup files during a session.

4. **Verify backup before proceeding.** After creating a backup, verify the backup file exists and has the same size as the original before making any changes.

5. **Retention policy.** Backups older than 7 days may be cleaned up by `uap memory maintain`. Recent backups (< 7 days) must never be automatically deleted.

## Enforcement Level

[REQUIRED]

## Related Tools

- cp: File copy
- rsync: Directory sync
- git-stash: Git-level backup

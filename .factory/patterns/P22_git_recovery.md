# P22: Git Recovery Forensics

**Category**: Recovery
**Abbreviation**: Git-Recovery

## Pattern

For lost/corrupted git commits, use git reflog and fsck for forensic recovery before attempting fixes.

## Rule

```
Lost commits → git reflog → git fsck --lost-found → recover.
```

## Implementation

1. Check reflog for recent HEAD positions
2. Use fsck to find dangling commits
3. Recover via cherry-pick or reset
4. Verify recovery before claiming success

## Recovery Commands

```bash
# Find lost commits
git reflog
git fsck --lost-found

# Recover specific commit
git cherry-pick <commit-hash>
# Or reset to commit
git reset --hard <commit-hash>
```

## Prevention

Always create backup branch before risky operations:
```bash
git branch backup-branch
```

## Anti-Pattern

❌ Assuming commits are gone forever
❌ Starting over without checking reflog
❌ Force pushing without recovery attempt

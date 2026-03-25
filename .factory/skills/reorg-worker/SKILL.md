---
name: reorg-worker
description: Project reorganization worker for consolidating hooks, skills, policies, and cleaning up redundancies
---

# Reorganization Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features that involve:
- Consolidating duplicate files (hooks, skills, policies)
- Creating symlinks to replace copies
- Removing stale/empty directories
- Fixing broken documentation links
- General project structure cleanup

## Required Skills

None.

## Work Procedure

### 1. Understand the Feature
- Read the feature description carefully
- Identify ALL files/directories affected
- Read current state of source and target locations

### 2. Plan Changes
- List every file operation (copy, symlink, delete)
- Identify the canonical source for each consolidation
- Plan the order of operations to avoid breaking anything mid-change

### 3. Execute Changes
- For hook consolidation: create symlinks from platform dirs to `.factory/hooks/`
- For skill consolidation: move unique skills to `.factory/skills/`, remove duplicates
- For policy consolidation: merge into `policies/`, remove duplicates
- For cleanup: remove empty dirs, fix broken links

### 4. Verify Build
```bash
cd /home/cogtek/dev/miller-tech/universal-agent-protocol
npm run build
npm test
```
Build and tests MUST pass after reorganization.

### 5. Verify Symlinks
```bash
# Verify symlinks resolve correctly
for dir in .claude/hooks .codex/hooks .cursor/hooks .forge/hooks .omp/hooks; do
  if [ -d "$dir" ]; then
    ls -la "$dir"/ | head -5
  fi
done
```

### 6. Commit
- Stage all changes
- Commit with descriptive message

## Example Handoff

```json
{
  "salientSummary": "Consolidated hooks from 6 platform directories into .factory/hooks/ as single source of truth. Created symlinks in .claude/hooks/, .codex/hooks/, .cursor/hooks/, .forge/hooks/, .omp/hooks/. Removed 72 duplicate hook files. npm run build and npm test pass with zero new failures.",
  "whatWasImplemented": "Made .factory/hooks/ canonical. Replaced 72 hook copies across 5 platform dirs with symlinks. Verified all symlinks resolve correctly. Build and tests pass.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "ls -la .claude/hooks/ | head -5", "exitCode": 0, "observation": "All entries are symlinks to ../../.factory/hooks/"},
      {"command": "npm run build", "exitCode": 0, "observation": "Build succeeded"},
      {"command": "npm test", "exitCode": 0, "observation": "All tests pass"}
    ],
    "interactiveChecks": []
  },
  "tests": {"added": []},
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Consolidation would break existing CI/CD pipelines
- Files have platform-specific content that can't be symlinked
- Build or tests fail after changes and root cause is unclear

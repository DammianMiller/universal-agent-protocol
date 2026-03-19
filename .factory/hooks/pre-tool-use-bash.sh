#!/usr/bin/env bash
# UAP Dangerous Command Guard — BLOCKING hook
# Event: PreToolUse (matcher: Bash)
# Exit 2 = BLOCK the command. Exit 0 = allow.
# Enforces: iac-pipeline-enforcement, worktree-enforcement, git safety policies.
set -euo pipefail

# Read tool input from stdin (JSON)
INPUT=$(cat)

# Extract command from tool_input
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

# If we can't determine the command, fail open
if [ -z "$CMD" ]; then
  exit 0
fi

# ─── IaC Pipeline Enforcement ───────────────────────────────────
# Block local terraform apply/destroy (policies/iac-pipeline-enforcement.md)
# Allow: terraform fmt, validate, init, plan, output, show, state list, graph
if echo "$CMD" | grep -qiE '\bterraform\s+(apply|destroy)\b'; then
  echo "BLOCKED [iac-pipeline-enforcement]: terraform apply/destroy MUST go through CI/CD pipeline. Local execution is prohibited. Use: terraform fmt, validate, or plan locally. See policies/iac-pipeline-enforcement.md" >&2
  exit 2
fi

# ─── Git Force Push Protection ──────────────────────────────────
# Block force pushes to any branch
if echo "$CMD" | grep -qE 'git\s+push\s+.*--force|git\s+push\s+-f\b|git\s+push\s+.*--force-with-lease'; then
  echo "BLOCKED [git-safety]: Force push is prohibited. Use standard push and resolve conflicts through PRs. If you believe this is necessary, ask the user for explicit approval first." >&2
  exit 2
fi

# ─── Direct Master/Main Commit Protection ───────────────────────
# Block git commit when on master/main AND not inside a worktree
if echo "$CMD" | grep -qE '\bgit\s+commit\b'; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)
  CHECK_DIR="${CWD:-$PROJECT_DIR}"

  # Only block if NOT inside a worktree directory
  if ! echo "$CHECK_DIR" | grep -q '\.worktrees/'; then
    CURRENT_BRANCH=$(git -C "$CHECK_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
      echo "BLOCKED [worktree-enforcement]: Direct commits to ${CURRENT_BRANCH} are prohibited. Create a worktree first: uap worktree create <slug>. See policies/worktree-enforcement.md" >&2
      exit 2
    fi
  fi
fi

# ─── Direct Push to Master/Main Protection ──────────────────────
# Block git push targeting main/master directly (not through PR)
if echo "$CMD" | grep -qE '\bgit\s+push\b'; then
  # Block explicit pushes to main/master
  if echo "$CMD" | grep -qE '\bgit\s+push\s+(origin\s+)?(main|master)\b'; then
    echo "BLOCKED [worktree-enforcement]: Direct push to main/master is prohibited. Use: uap worktree pr <id> to create a PR instead. See policies/worktree-enforcement.md" >&2
    exit 2
  fi
fi

# ─── Destructive Git Operations ─────────────────────────────────
# Block git reset --hard and git clean -f outside worktrees
if echo "$CMD" | grep -qE '\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f'; then
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)
  if ! echo "${CWD:-.}" | grep -q '\.worktrees/'; then
    echo "BLOCKED [git-safety]: Destructive git operations (reset --hard, clean -f) are prohibited outside worktrees. These can destroy uncommitted work in the project root." >&2
    exit 2
  fi
fi

# ─── Manual Version Edit Protection ─────────────────────────────
# Block direct edits to package.json version field via sed/awk
if echo "$CMD" | grep -qE "(sed|awk).*package\.json.*(version|\"version\")|((sed|awk).*version.*package\.json)|(jq.*\.version.*package\.json)"; then
  echo "BLOCKED [semver-versioning]: Manual package.json version edits are prohibited. Use: npm run version:patch, version:minor, or version:major. See policies/semver-versioning.md" >&2
  exit 2
fi

# Command allowed
exit 0

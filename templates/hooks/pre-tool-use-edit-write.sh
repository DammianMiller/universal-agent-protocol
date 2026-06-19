#!/usr/bin/env bash
# UAP Worktree File Guard — BLOCKING hook
# Event: PreToolUse (matcher: Edit|Write)
# Exit 2 = BLOCK the edit/write. Exit 0 = allow.
# Enforces: worktree-file-guard, worktree-enforcement policies.
#
# Scope: ONLY enforces inside the project repo (resolved via `git rev-parse
# --show-toplevel` from PWD). Files outside the repo (e.g. ~/.claude/projects/
# memory area, /tmp scratch, system files) are always allowed — the worktree
# policy governs repo-tracked work only. See: _hook-fix-2026-04-29.
set -euo pipefail

# --- Loop Protection: track frequency of blocking events ---
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${HOOK_DIR}/loop-protection.sh" ]; then
  # shellcheck disable=SC1091
  source "${HOOK_DIR}/loop-protection.sh"
fi

# Read tool input from stdin (JSON)
INPUT=$(cat)

# Extract file_path from tool_input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null || true)

# If we can't determine the file path, fail open
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Resolve to canonical absolute path. -m allows the file to not exist yet
# (common for Write to a new file).
ABS_PATH="$(realpath -m "$FILE_PATH" 2>/dev/null || printf '%s' "$FILE_PATH")"

# Resolve repo root from current working directory. In a BARE repo (this
# project's layout) `git rev-parse --show-toplevel` returns empty even from the
# project root — so fall back to the root derived from the hook's own location
# (<root>/.factory/hooks/) and FAIL CLOSED. A missing repo root must not silently
# disable the worktree guard, which previously let root-dir edits through.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(cd "$HOOK_DIR/../.." 2>/dev/null && pwd || true)"
fi
if [ -z "$REPO_ROOT" ]; then
  # Genuinely cannot locate a project root — nothing to enforce against.
  exit 0
fi

# Scope guard (the regression fix): if the file being edited is outside the
# repo root, always allow. The worktree policy only applies to in-repo files.
case "$ABS_PATH" in
  "$REPO_ROOT"/*) : ;;       # inside repo — continue to in-repo checks
  *) exit 0 ;;               # outside repo — allow
esac

# Exempt paths — runtime data, not source code (substring match, intentional)
EXEMPT_PATTERNS=(
  "agents/data/"
  "node_modules/"
  ".uap-backups/"
  ".uap/"
  ".git/"
  "dist/"
)

for pattern in "${EXEMPT_PATTERNS[@]}"; do
  if echo "$ABS_PATH" | grep -q "$pattern"; then
    exit 0
  fi
done

# Allow if path is inside a worktree (substring match, handles nested worktrees).
# Before allowing a real source edit, announce it to the SHARED coordination DB
# and check for a live overlap so independently-launched agents coordinate and
# never silently clobber the same file. Always fails open.
if echo "$ABS_PATH" | grep -q '\.worktrees/'; then
  if [ -f "$HOOK_DIR/coordinate-file.sh" ]; then
    # Shared coordination DB = the MAIN worktree's, so agents running in
    # different .worktrees/ all see each other. git-common-dir resolves the
    # shared .git even from a linked worktree.
    GCD="$(git rev-parse --git-common-dir 2>/dev/null || true)"
    case "$GCD" in
      /*) : ;;
      "") GCD="" ;;
      *) GCD="$PWD/$GCD" ;;
    esac
    if [ -n "$GCD" ]; then
      MAIN_ROOT="$(cd "$(dirname "$GCD")" 2>/dev/null && pwd || echo "$REPO_ROOT")"
    else
      MAIN_ROOT="$REPO_ROOT"
    fi
    COORD_DB="$MAIN_ROOT/agents/data/coordination/coordination.db"
    # Repo-relative path so the same logical file across worktrees collides.
    REL_PATH="${ABS_PATH#"$REPO_ROOT"/}"
    WT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null || true)"
    if [ -n "$SESSION_ID" ]; then
      AGENT_ID="claude-${SESSION_ID}"
    else
      AGENT_ID="${UAP_AGENT_ID:-claude-${WT_BRANCH:-unknown}}"
    fi
    if bash "$HOOK_DIR/coordinate-file.sh" \
      "$COORD_DB" "$AGENT_ID" "${UAP_AGENT_NAME:-agent}" "$WT_BRANCH" "$REL_PATH" "$ABS_PATH"; then
      exit 0
    fi
    # Non-zero from coordinate-file.sh = live-conflict block (reason on stderr).
    exit 2
  fi
  exit 0
fi

# BLOCK: path is inside the repo, not in a worktree, not exempt.
if type lp_record_invocation &>/dev/null; then
  lp_record_invocation "pre-tool-edit-block"
fi
echo '{"decision":"block","reason":"WORKTREE POLICY VIOLATION: File path is outside .worktrees/. All edits must target files inside a worktree. Run: uap worktree create <slug> then edit files in .worktrees/NNN-<slug>/. See policies/worktree-file-guard.md"}' >&2
exit 2

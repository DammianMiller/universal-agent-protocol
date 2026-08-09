#!/usr/bin/env bash
# UAP Dangerous Command Guard — BLOCKING hook
# Event: PreToolUse (matcher: Bash)
# Exit 2 = BLOCK the command. Exit 0 = allow.
# Enforces: iac-pipeline-enforcement, worktree-enforcement, git safety policies.
set -euo pipefail

# --- Loop Protection: track frequency of blocking events ---
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${HOOK_DIR}/loop-protection.sh" ]; then
  source "${HOOK_DIR}/loop-protection.sh"
fi

# Read tool input from stdin (JSON)
INPUT=$(cat)

# Extract command from tool_input
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

# If we can't determine the command, fail open
if [ -z "$CMD" ]; then
  exit 0
fi

# ─── Protocol Tag Injection Guard ────────────────────────────────
# Reject Bash payloads that still contain standalone protocol tag lines.
# These fragments can appear after malformed tool-call rendering and must
# never reach shell evaluation.
if printf '%s\n' "$CMD" | grep -qE '^\s*</?(tool_call|tool_response|parameter(=[^>]*)?|function(=[^>]*)?|think)\s*>\s*$'; then
  echo "BLOCKED [bash-safety]: Command contains standalone XML/protocol tag lines. Remove tool-call tag artifacts before execution." >&2
  exit 2
fi

# ─── Inference-Infrastructure Protection ────────────────────────
# Observed live (qwen, 2026-07-12): during playtest loops the model ran
# `pkill -9 -f python3` (killed the UAP anthropic proxy) and
# `kill $(lsof -t -i:8080)` (killed llama-server to free the port for its
# own http.server). systemd restarts recover, but each kill = full model
# reload + slot-cache loss. Block kills that can only hit the stack the
# model itself runs on; killing a SPECIFIC process pattern (e.g.
# `pkill -f "python3 -m http.server"`) stays allowed.
INFRA_MSG="BLOCKED [infra-protect]: This command can kill the inference stack you are running on (llama-server :8080 / UAP proxy :4000 / embeddings :8081). Kill only your own processes by SPECIFIC pattern (e.g. pkill -f 'python3 -m http.server 8765') and serve on a port other than 8080/4000/8081."
# 1) Bare-interpreter pkill/killall (pattern matches EVERY python/node proc)
if echo "$CMD" | grep -qE "\b(pkill|killall)\b(\s+-[A-Za-z0-9-]+)*\s+([\"'](python[0-9.]*|node|bun|deno)[\"']|(python[0-9.]*|node|bun|deno)([[:space:]]|;|\||&|$))"; then
  echo "$INFRA_MSG" >&2
  exit 2
fi
# 2) Kill aimed at the inference services by name
if echo "$CMD" | grep -qE "\b(pkill|kill|killall)\b[^|;&]*(llama-server|anthropic_proxy|nomic)"; then
  echo "$INFRA_MSG" >&2
  exit 2
fi
# 3) Kill by critical port (lsof/fuser on 8080/4000/8081)
if echo "$CMD" | grep -qE "\bkill\b[^|;&]*lsof[^|;&]*-i[: ]*(8080|4000|8081)\b|\bfuser\s+(-[A-Za-z]+\s+)*-?k[^|;&]*(8080|4000|8081)/tcp"; then
  echo "$INFRA_MSG" >&2
  exit 2
fi
# 4) Stopping/restarting the inference services via systemctl
if echo "$CMD" | grep -qE "systemctl\s+(--user\s+)?(stop|restart|kill|disable)\s+\S*(uap-llama-server|uap-anthropic-proxy|nomic-embeddings)"; then
  echo "$INFRA_MSG" >&2
  exit 2
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
      # Allow automated version bump commits (message contains "bump version")
      if echo "$CMD" | grep -qE 'chore: bump version|version:patch|version:minor|version:major|version-bump'; then
        exit 0
      fi
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
    # Allow push after version bump (git push && git push --tags pattern)
    if echo "$CMD" | grep -qE 'git\s+push\s+--tags|git\s+push\s*&&\s*git\s+push\s+--tags'; then
      exit 0
    fi
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
# Block direct edits to package.json version field via sed/awk/jq.
#
# Scoped to a single shell STATEMENT. Matching across the whole command line
# meant any sed/awk anywhere plus `package.json` and `version` anywhere later
# tripped it, so reading the version alongside unrelated text munging was
# refused:  `curl ... | sed 's/^/x/'; node -p "require('./package.json').version"`
# That is a READ. Splitting on ; && || | and newline keeps every real edit
# (each has sed/awk/jq and package.json inside one statement) and drops the
# cross-statement coincidence. Verified against both corpora before and after.
if printf '%s' "$CMD" | tr ';|&\n' '\n\n\n\n' | grep -qE "(sed|awk).*package\.json.*(version|\"version\")|((sed|awk).*version.*package\.json)|(jq.*\.version.*package\.json)"; then
  echo "BLOCKED [semver-versioning]: Manual package.json version edits are prohibited. Use: npm run version:patch, version:minor, or version:major. See policies/semver-versioning.md" >&2
  exit 2
fi

# Command allowed
exit 0

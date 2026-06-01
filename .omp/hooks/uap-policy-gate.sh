#!/usr/bin/env bash
# uap-policy-gate: invoke executable UAP policy enforcers for the current tool call.
# Reads hook payload on stdin (JSON). Exit 0 = allow, 2 = block (stderr becomes feedback).
set -euo pipefail

PAYLOAD="$(cat)"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve two roots:
#   CHECKOUT_ROOT — the current working tree (a worktree under .worktrees/, or the
#                   main checkout). git-based enforcers run their `git diff` here.
#   MAIN_ROOT     — the main checkout that holds RUNTIME data. policies.db and the
#                   .policy-tools/ enforcers live ONLY here (policies.db is gitignored
#                   and is never copied into worktrees).
# Previously the DB path was resolved against the checkout root, so when a tool ran
# from inside a worktree the gate found no policies.db and silently skipped ALL
# policy enforcement. Anchor DB + enforcer paths to MAIN_ROOT to fix that, while
# keeping the enforcer working directory on the actual working tree.
CHECKOUT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -z "$CHECKOUT_ROOT" ]] && CHECKOUT_ROOT="$(cd "$HOOK_DIR/../.." 2>/dev/null && pwd || pwd)"
MAIN_ROOT="${CHECKOUT_ROOT%%/.worktrees/*}"

# Anchor enforcers to MAIN_ROOT via _common.repo_root(). This is the project root
# that *contains* the worktrees, so path-relative enforcers reason correctly from
# any cwd — e.g. worktree-required sees an edit as ".worktrees/NNN/..." (allow)
# instead of, when run from inside a worktree, resolving repo_root to the worktree
# itself and mis-flagging a legitimate worktree edit as a root edit (false block).
export UAP_REPO_ROOT="$MAIN_ROOT"
# git-diff enforcers (test-gate, schema-diff, iac-parity) must run git against the
# actual WORKING TREE, not the (possibly bare) MAIN_ROOT. Expose the current checkout
# so _common.worktree_root() targets the worktree when an op runs from inside one.
export UAP_WORKTREE_ROOT="$CHECKOUT_ROOT"
cd "$MAIN_ROOT"

TOOL="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_name") or d.get("tool") or "")' 2>/dev/null || true)"
ARGS="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get("tool_input") or d.get("args") or {}))' 2>/dev/null || echo '{}')"

[[ -z "$TOOL" ]] && exit 0

DB="$MAIN_ROOT/agents/data/memory/policies.db"
[[ ! -f "$DB" ]] && exit 0

# Iterate active policies with attached executable tools
while IFS='|' read -r pid pname tool; do
  [[ -z "$pid" ]] && continue
  enforcer="$MAIN_ROOT/.policy-tools/${pid}_${tool}.py"
  [[ ! -f "$enforcer" ]] && continue
  out="$(python3 "$enforcer" --operation "$TOOL" --args "$ARGS" 2>/dev/null || true)"
  allowed="$(printf '%s' "$out" | python3 -c 'import json,sys;
try: d=json.loads(sys.stdin.read()); print("1" if d.get("allowed",True) else "0")
except: print("1")' 2>/dev/null || echo 1)"
  if [[ "$allowed" == "0" ]]; then
    reason="$(printf '%s' "$out" | python3 -c 'import json,sys;
try: print(json.loads(sys.stdin.read()).get("reason",""))
except: print("")' 2>/dev/null || echo "")"
    echo "[UAP policy blocked: $pname] $reason" >&2
    exit 2
  fi
done < <(sqlite3 "$DB" "SELECT p.id, p.name, t.toolName FROM policies p JOIN executable_tools t ON t.policyId=p.id WHERE p.isActive=1;")

exit 0

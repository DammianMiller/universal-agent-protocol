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
# Resolve the working tree the operation TARGETS, not just the hook's own cwd.
# For a Bash op the command usually `cd`s into a worktree before running git, but
# this hook fires BEFORE that cd — so using the hook's cwd yielded the MAIN
# checkout and made git-diff enforcers (expert-review, local-build) reason about
# the wrong branch on compound `cd worktree && git ...` commands. Prefer, in
# order: a leading `cd <path>` in the command, the payload's invocation cwd, then
# git-toplevel from the hook's cwd.
_CD_TARGET="$(UAP_PAYLOAD="$PAYLOAD" python3 - <<'PYEOF'
import json, os, re
try:
    d = json.loads(os.environ.get("UAP_PAYLOAD") or "{}")
    ti = d.get("tool_input") or d.get("args") or {}
    cmd = ti.get("command") or ""
    m = re.match(r'\s*cd\s+(?:"([^"]+)"|\x27([^\x27]+)\x27|([^\s;&|]+))', cmd)
    print((m.group(1) or m.group(2) or m.group(3)) if m else "")
except Exception:
    print("")
PYEOF
)"
_PAYLOAD_CWD="$(UAP_PAYLOAD="$PAYLOAD" python3 - <<'PYEOF'
import json, os
try:
    print(json.loads(os.environ.get("UAP_PAYLOAD") or "{}").get("cwd") or "")
except Exception:
    print("")
PYEOF
)"
CHECKOUT_ROOT=""
for _cand in "$_CD_TARGET" "$_PAYLOAD_CWD"; do
  [[ -z "$_cand" || ! -d "$_cand" ]] && continue
  _top="$(git -C "$_cand" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$_top" ]] && { CHECKOUT_ROOT="$_top"; break; }
done
[[ -z "$CHECKOUT_ROOT" ]] && CHECKOUT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
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
# Delivery enforcement defaults to BLOCK for UAP-managed projects: substantive
# source edits must route through `uap deliver` (verified completion against the
# gates). The `:-` preserves any explicit operator/CI override (advisory|block).
# Escape hatches still apply: UAP_DELIVER_ACTIVE=1 (inside deliver) / UAP_DELIVER_BYPASS=1.
export UAP_ENFORCE_DELIVERY="${UAP_ENFORCE_DELIVERY:-block}"
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
    # R1: consume the enforcer's route:deliver signal (log intent, opt-in
    # background auto-route to `uap deliver`). Falls back to the plain reason if
    # the helper is missing/fails.
    msg=""
    if [[ -f "$HOOK_DIR/deliver_autoroute.py" ]]; then
      msg="$(printf '%s' "$out" | python3 "$HOOK_DIR/deliver_autoroute.py" --tool "$TOOL" --args "$ARGS" --root "$MAIN_ROOT" --policy "$pname" 2>/dev/null || true)"
    fi
    if [[ -z "$msg" ]]; then
      reason="$(printf '%s' "$out" | python3 -c 'import json,sys;
try: print(json.loads(sys.stdin.read()).get("reason",""))
except: print("")' 2>/dev/null || echo "")"
      msg="[UAP policy blocked: $pname] $reason"
    fi
    echo "$msg" >&2
    exit 2
  fi
done < <(sqlite3 "$DB" "SELECT p.id, p.name, t.toolName FROM policies p JOIN executable_tools t ON t.policyId=p.id WHERE p.isActive=1;")

exit 0

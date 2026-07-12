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

# FAIL-CLOSED for the enforcement control surface. The gate is fail-SOFT by
# design (a broken/absent enforcer must not wedge ALL work) — but that same
# fail-open makes anything that BREAKS the enforcer a silent bypass of the
# self-protect control. So: if THIS operation touches the enforcement surface
# (policy DB/enforcers, .uap.json, proxy env, hook scripts) or sets a
# bypass/relax flag, the gate fails CLOSED (exit 2) whenever the self-protect
# enforcer cannot actually run and make the call. Normal ops keep failing open.
SEC_SENSITIVE="$(printf '%s' "$ARGS" | TOOL="$TOOL" python3 -c '
import json, os, re, sys
try: a = json.loads(sys.stdin.read() or "{}")
except Exception: a = {}
markers = ("/.policy-tools/", "/src/policies/", "/policies/", "/.uap.json",
           ".uap.json", "/.uap/", "anthropic-proxy.env", "uap-policy-gate.sh",
           "uap-reactor-prompt.sh", "pre-tool-use")
target = a.get("file_path") or a.get("path") or a.get("target") or ""
cmd = a.get("command") or ""
low = ("/" + str(target)).lower()
hit = any(m in low for m in markers)
bypass = re.search(
    r"UAP_DELIVER_BYPASS\s*=\s*[\x27\"]?1|UAP_ENFORCE_DELIVERY\s*=\s*[\x27\"]?(advisory|off|0|false|no)"
    r"|UAP_SELF_PROTECT_OFF\s*=\s*[\x27\"]?1|UAP_NO_WORKTREE\s*=\s*[\x27\"]?1|UAP_WORKDIR_SCOPE_OFF\s*=\s*[\x27\"]?1|UAP_USER_VALIDATION\s*=\s*[\x27\"]?0",
    cmd, re.I)
print("1" if (hit or bypass) else "0")
' 2>/dev/null || echo 1)"

# Operator out-of-band override disables the fail-closed guard too.
[[ "${UAP_SELF_PROTECT_OFF:-}" == "1" ]] && SEC_SENSITIVE=0

fail_closed() {
  echo "[UAP policy gate] FAIL-CLOSED: this operation touches the enforcement control surface but the self-protect enforcer could not run (${1:-machinery unavailable}). Blocked so a broken/absent gate can't become a bypass. (Operator override: UAP_SELF_PROTECT_OFF=1.)" >&2
  exit 2
}

DB="$MAIN_ROOT/agents/data/memory/policies.db"
if [[ ! -f "$DB" ]]; then
  [[ "$SEC_SENSITIVE" == "1" ]] && fail_closed "policies.db not found"
  exit 0
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  [[ "$SEC_SENSITIVE" == "1" ]] && fail_closed "sqlite3 not on PATH"
  exit 0
fi

# ─── Compliance execution logging ───────────────────────────────────────────
# Record one row per tool call into policy_executions so the dashboard's
# compliance section shows REAL check/block counts. The live enforcement path
# is this shell hook → Python enforcers, which never touched the table before
# (only the in-process TS policy manager did), so the dashboard read 0 checks
# forever. Fail-soft and bounded (prune ~1% of the time), and never on the hot
# path more than a single INSERT. Opt out with UAP_POLICY_LOG_EXEC=0.
record_execution() {
  # $1=allowed(0|1) $2=policyId $3=reason
  [[ "${UAP_POLICY_LOG_EXEC:-1}" == "0" ]] && return 0
  local allowed="$1" pid="${2:-gate}" reason="$3"
  local esc_args esc_reason
  esc_args="$(printf '%s' "$ARGS" | sed "s/'/''/g")"
  esc_reason="$(printf '%s' "$reason" | sed "s/'/''/g" | cut -c1-500)"
  sqlite3 "$DB" "INSERT INTO policy_executions
    (policyId, toolName, operation, args, result, allowed, reason, executedAt)
    VALUES ('$pid', '${TOOL//\'/\'\'}', '${TOOL//\'/\'\'}', '$esc_args',
            '{}', $allowed, '$esc_reason', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    DELETE FROM policy_executions WHERE id < (SELECT MAX(id)-2000 FROM policy_executions)
      AND (SELECT COUNT(*) FROM policy_executions) > 2000;" 2>/dev/null || true
}

# Did the self-protect enforcer actually run and make a decision this call?
sec_enforcer_ran=0

# Iterate active policies with attached executable tools
while IFS='|' read -r pid pname tool; do
  [[ -z "$pid" ]] && continue
  enforcer="$MAIN_ROOT/.policy-tools/${pid}_${tool}.py"
  if [[ ! -f "$enforcer" ]]; then
    # A missing self-protect enforcer on a sensitive op = fail closed.
    [[ "$SEC_SENSITIVE" == "1" && "$tool" == "enforcement_self_protect" ]] && fail_closed "enforcer file missing"
    continue
  fi
  out="$(python3 "$enforcer" --operation "$TOOL" --args "$ARGS" 2>/dev/null || true)"
  allowed="$(printf '%s' "$out" | python3 -c 'import json,sys;
try: d=json.loads(sys.stdin.read()); print("1" if d.get("allowed",True) else "0")
except: print("2")' 2>/dev/null || echo 2)"
  # allowed=2 => enforcer errored / emitted unparseable output. For a sensitive
  # op via the self-protect enforcer, that error must NOT default to allow.
  if [[ "$tool" == "enforcement_self_protect" ]]; then
    [[ "$SEC_SENSITIVE" == "1" && "$allowed" == "2" ]] && fail_closed "enforcer errored"
    sec_enforcer_ran=1
  fi
  # For all other enforcers, an error still fails open (unchanged behavior).
  [[ "$allowed" == "2" ]] && allowed=1
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
    record_execution 0 "$pid" "$msg"
    echo "$msg" >&2
    exit 2
  fi
done < <(sqlite3 "$DB" "SELECT p.id, p.name, t.toolName FROM policies p JOIN executable_tools t ON t.policyId=p.id WHERE p.isActive=1;")

# A sensitive op that no self-protect enforcer ever evaluated = the control
# surface is unguarded (self-protect not registered/active). Fail closed.
[[ "$SEC_SENSITIVE" == "1" && "$sec_enforcer_ran" == "0" ]] && fail_closed "self-protect not registered/active"

# Allowed: every active enforcer passed this operation.
record_execution 1 "gate" ""
exit 0

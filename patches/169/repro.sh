#!/usr/bin/env bash
# Reproduce the incident end-to-end against BOTH gate versions.
#
# THE INCIDENT: deleting .policy-tools/_common.py broke every materialized
# enforcer at import (they all `from _common import ...`). self-protect could
# no longer run, and because SEC_SENSITIVE only ever scanned file_path -- never
# the Bash command -- the "enforcer errored => fail closed" branch did not fire.
# The next `>> .uap/evidence/reads.log` was ALLOWED.
#
# Usage: repro.sh <old_gate.sh> <new_gate.sh>
set -uo pipefail

OLD_GATE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
NEW_GATE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT

# ── a minimal repo that looks like a UAP checkout ────────────────────────────
mkdir -p "$SB"/{.policy-tools,agents/data/memory,src/policies/enforcers,.uap/evidence,.claude/hooks}
git -C "$SB" init -q 2>/dev/null
git -C "$SB" config user.email t@t; git -C "$SB" config user.name t

# The helper every enforcer imports. A stub is enough: what is under test is the
# GATE's behaviour when the import fails, not this module's contents.
cat > "$SB/src/policies/enforcers/_common.py" <<'PY'
import json, sys
def parse_cli():
    a = sys.argv
    op = a[a.index("--operation") + 1] if "--operation" in a else ""
    ar = json.loads(a[a.index("--args") + 1]) if "--args" in a else {}
    return op, ar
def emit(allowed, reason):
    print(json.dumps({"allowed": bool(allowed), "reason": reason})); sys.exit(0)
PY
cp "$SB/src/policies/enforcers/_common.py" "$SB/.policy-tools/_common.py"

PID="11111111-1111-1111-1111-111111111111"
cat > "$SB/.policy-tools/${PID}_enforcement_self_protect.py" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli          # dies if _common.py is gone
op, args = parse_cli()
if op in ("Bash", "bash") and ".uap/evidence" in (args.get("command") or ""):
    emit(False, "BLOCKED: evidence is not agent-writable")
emit(True, "ok")
PY

python3 - "$SB" "$PID" <<'PY'
import sqlite3, sys
db = sqlite3.connect(f"{sys.argv[1]}/agents/data/memory/policies.db")
db.execute("CREATE TABLE policies (id TEXT, name TEXT, category TEXT, level TEXT,"
           " rawMarkdown TEXT, convertedFormat TEXT, executableTools TEXT, tags TEXT,"
           " createdAt TEXT, updatedAt TEXT, version INT, isActive INT, priority INT,"
           " enforcementStage TEXT)")
db.execute("CREATE TABLE executable_tools (id TEXT, policyId TEXT, toolName TEXT,"
           " code TEXT, language TEXT, createdAt TEXT)")
db.execute("CREATE TABLE policy_executions (id TEXT)")
db.execute("INSERT INTO policies VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1,'pre-exec')",
           (sys.argv[2], "Enforcement Self-Protect", "security", "REQUIRED",
            "# Enforcement Self-Protect", "", "", "", "", ""))
db.execute("INSERT INTO executable_tools VALUES (?,?,?,?,?,?)",
           ("t1", sys.argv[2], "enforcement_self_protect", "", "python", ""))
db.commit()
PY

run_gate() {  # $1=gate  -> prints exit code
  cp "$1" "$SB/.claude/hooks/uap-policy-gate.sh"
  chmod +x "$SB/.claude/hooks/uap-policy-gate.sh"
  printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo x >> .uap/evidence/reads.log"}}' "$SB" \
    | (cd "$SB" && bash .claude/hooks/uap-policy-gate.sh >/dev/null 2>&1; echo $?)
}

echo "=== 1. healthy surface (_common.py present) — both must BLOCK (exit 2) ==="
printf '  old gate exit=%s\n' "$(run_gate "$OLD_GATE")"
printf '  new gate exit=%s\n' "$(run_gate "$NEW_GATE")"

echo
echo "=== 2. THE INCIDENT: _common.py deleted — enforcer cannot import ==="
rm -f "$SB/.policy-tools/_common.py"
old_rc="$(run_gate "$OLD_GATE")"
rm -f "$SB/.policy-tools/_common.py"      # old gate may have restored nothing
printf '  old gate exit=%s   <- 0 means the write was ALLOWED (the bug)\n' "$old_rc"
rm -f "$SB/.policy-tools/_common.py"
new_rc="$(run_gate "$NEW_GATE")"
printf '  new gate exit=%s   <- 2 means blocked/fail-closed\n' "$new_rc"
printf '  _common.py restored by the new gate: %s\n' \
  "$([ -f "$SB/.policy-tools/_common.py" ] && echo YES || echo NO)"

echo
echo "=== 3. unrecoverable: helper missing from BOTH locations ==="
rm -f "$SB/.policy-tools/_common.py" "$SB/src/policies/enforcers/_common.py"
printf '  new gate exit=%s   <- 2 = fail closed when repair is impossible\n' "$(run_gate "$NEW_GATE")"

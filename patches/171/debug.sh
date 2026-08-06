#!/usr/bin/env bash
# Run a candidate gate against a tampered sandbox and show its stderr.
# Usage: debug.sh <candidate-gate.sh>
set -uo pipefail
G="$1"
SB="$(mktemp -d)"
mkdir -p "$SB"/{.policy-tools,agents/data/memory,src/policies/enforcers,.uap/evidence,.claude/hooks}
git -C "$SB" init -q 2>/dev/null

printf 'HELPER\n'   > "$SB/src/policies/enforcers/_common.py"
printf 'REAL\n'     > "$SB/src/policies/enforcers/tool.py"
cp "$SB/src/policies/enforcers/_common.py" "$SB/.policy-tools/_common.py"
cp "$SB/src/policies/enforcers/tool.py"    "$SB/.policy-tools/aaa_tool.py"
( cd "$SB/.policy-tools" && sha256sum _common.py aaa_tool.py > .integrity.sha256 )
printf '%s\n' "$SB/src/policies/enforcers" > "$SB/.policy-tools/.integrity.source"

printf 'TAMPERED\n' > "$SB/.policy-tools/aaa_tool.py"

cp "$G" "$SB/.claude/hooks/uap-policy-gate.sh"
printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm run build"}}' "$SB" \
  | bash -x "$SB/.claude/hooks/uap-policy-gate.sh" > "$SB/out.txt" 2> "$SB/trace.txt"
echo "exit=$?"
echo "---- trace tail ----"; tail -30 "$SB/trace.txt"
echo "---- content after run ----"
cat "$SB/.policy-tools/aaa_tool.py"
rm -rf "$SB"

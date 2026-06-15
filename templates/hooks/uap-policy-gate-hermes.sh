#!/usr/bin/env bash
# UAP policy gate — Hermes Agent (NousResearch) variant.
#
# Hermes `pre_tool_call` hooks decide via a JSON object on STDOUT, and are
# FAIL-OPEN: a non-zero exit, timeout, or malformed JSON only logs a warning and
# lets the tool proceed. The shared uap-policy-gate.sh instead signals a block
# with `exit 2` (Claude Code convention), which Hermes would ignore.
#
# This wrapper runs the shared gate and TRANSLATES its verdict into the Hermes
# contract: it always exits 0 and always prints valid JSON —
#   {"decision":"block","reason":"…"}   when the gate blocks (exit 2)
#   {}                                   otherwise (allow)
# so a real block is reliably enforced rather than silently failing open.
#
# Hermes stdin payload: {"hook_event_name":"pre_tool_call","tool_name":...,
# "tool_input":{...},"session_id":...,"cwd":...}. uap-policy-gate.sh reads the
# same tool_name/tool_input fields, so the payload is passed through unchanged.

set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/uap-policy-gate.sh"

PAYLOAD="$(cat)"

# No shared gate present → allow (fail-open, consistent with non-UAP repos).
if [ ! -f "$GATE" ]; then
  echo '{}'
  exit 0
fi

STDERR_FILE="$(mktemp 2>/dev/null || echo /tmp/uap-hermes-gate.$$)"
printf '%s' "$PAYLOAD" | bash "$GATE" >/dev/null 2>"$STDERR_FILE"
CODE=$?
REASON="$(tr -d '\r' < "$STDERR_FILE" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
rm -f "$STDERR_FILE" 2>/dev/null || true

if [ "$CODE" -eq 2 ]; then
  printf '{"decision":"block","reason":"%s"}\n' "${REASON:-blocked by UAP policy}"
else
  echo '{}'
fi
exit 0

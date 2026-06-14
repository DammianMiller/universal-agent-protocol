#!/usr/bin/env bash
# UAP Reactor Hook (UserPromptSubmit) — dynamic capability auto-apply.
# Generalizes pattern-rag-prompt.sh: instead of patterns only, it calls the
# full `uap react` resolver (experts + skills + patterns, confidence-gated) and
# injects the result as additionalContext so the model sees it before replying.
# Fails safely — never blocks the agent (always exits 0).
#
# Works across Claude Code / Factory / Cursor (all share the UserPromptSubmit
# event + the hookSpecificOutput.additionalContext output shape).
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-$(pwd)}}}"

# Read the harness payload and extract the user's prompt.
INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('prompt',''))
except Exception: pass" 2>/dev/null || true)

# Skip trivial prompts — not worth a resolver round-trip.
[ "${#PROMPT}" -lt 12 ] && exit 0

# Resolve the uap binary (UAP_BIN override allows testing against a local build).
UAP_BIN="${UAP_BIN:-$(command -v uap 2>/dev/null || true)}"
[ -z "$UAP_BIN" ] && exit 0

# Build the reactor payload and call `uap react`.
PAYLOAD=$(UAP_PROMPT="$PROMPT" UAP_CWD="$PROJECT_DIR" python3 -c "import json,os
print(json.dumps({'event':'user-prompt','promptText':os.environ['UAP_PROMPT'],'cwd':os.environ['UAP_CWD']}))" 2>/dev/null || true)
[ -z "$PAYLOAD" ] && exit 0

RESULT=$(printf '%s' "$PAYLOAD" | $UAP_BIN react 2>/dev/null || true)
[ -z "$RESULT" ] && exit 0

INJECT=$(printf '%s' "$RESULT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('inject',''))
except Exception: pass" 2>/dev/null || true)
[ -z "$INJECT" ] && exit 0

# Emit the harness additionalContext block.
UAP_INJECT="$INJECT" python3 -c "import json,os
print(json.dumps({'hookSpecificOutput':{'hookEventName':'UserPromptSubmit','additionalContext':os.environ['UAP_INJECT']}}))"

exit 0

#!/usr/bin/env bash
# UAP Schema-Change Reminder (PostToolUse) — enforce gap-fill.
# Fires when a schema/contract file is edited, reminding the agent to run
# `uap schema-diff` and re-verify API/consumer contracts before finalizing
# (the CLAUDE.md "Schema Diff Gate", auto-triggered).
# Advisory only — never blocks (always exits 0).
set -euo pipefail

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | python3 -c "import json,sys
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input') or d.get('args') or {}
    print(ti.get('file_path') or ti.get('path') or '')
except Exception:
    pass" 2>/dev/null || true)

[ -z "$FILE" ] && exit 0

case "$FILE" in
  *.schema.ts|*schema*.ts|*/types.ts|*.proto|*.graphql|*.gql|*openapi*|*swagger*|*.avsc|*.prisma)
    echo "[uap schema-gate] '$FILE' looks like a schema/contract file. Run \`uap schema-diff\` and re-verify API/consumer contracts before finalizing this change." >&2
    ;;
esac

exit 0

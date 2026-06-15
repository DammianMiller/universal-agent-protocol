#!/usr/bin/env bash
# ensure-exec-bits.sh — guarantee that shipped shebang scripts are executable
# before publish. npm packs files with their filesystem mode, so a tracked
# script committed as 100644 ships non-executable. Runs in prepublishOnly.
#
# Scope: shipped dirs only (must match package.json "files"). Only files that
# begin with a shebang (#!) are touched; imported .ts/.cjs modules and .j2
# templates are left alone (a leading shebang on a module is ignored at import).
set -euo pipefail
cd "$(dirname "$0")/../.."

SHIPPED=(src/policies/enforcers tools/agents templates config scripts/setup scripts/maintenance dist)
fixed=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in *.ts|*.j2|*.d.ts) continue ;; esac
  if head -c2 "$f" 2>/dev/null | grep -q '#!' && [ ! -x "$f" ]; then
    chmod +x "$f"
    echo "ensure-exec-bits: +x $f"
    fixed=$((fixed + 1))
  fi
done < <(git ls-files -- "${SHIPPED[@]}" 2>/dev/null | grep -E '\.(sh|py|cjs)$')

echo "ensure-exec-bits: ${fixed} script(s) made executable"
exit 0

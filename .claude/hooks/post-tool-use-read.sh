#!/usr/bin/env bash
# UAP Read Logger — INFORMATIONAL hook
# Event: PostToolUse (matcher: Read|Grep|Glob)
# Appends "<epoch>\t<path>" to .uap/read_log.state, which is the evidence the
# codebase-read-before-plan enforcer checks before allowing a plan to be emitted.
#
# Without this hook that enforcer has no writer: the log goes stale, every entry
# ages past its 30-minute window, and ExitPlanMode is blocked permanently with a
# remedy ("read the codebase first") that can never be satisfied.
#
# Runs on EVERY Read/Grep/Glob — thousands of times a session, in the latency
# path of each one — so it does its work in bash builtins and forks exactly once
# (jq, which earns it: the payload shape differs per tool).
#
# Always exits 0 (never blocks).
set -uo pipefail

# Drain stdin without forking `cat`. `read -d ''` returns non-zero at EOF while
# still populating INPUT, so the failure is expected, not an error.
IFS= read -r -d '' INPUT || true
[ -n "${INPUT:-}" ] || exit 0

# Read passes file_path; Grep/Glob pass path (search root) and/or pattern.
TARGET=$(jq -r '
  .tool_input.file_path // .tool_input.filePath // .tool_input.path // .tool_input.pattern // empty
' 2>/dev/null <<< "$INPUT" || true)
[ -n "$TARGET" ] || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
STATE_DIR="${UAP_STATE_DIR:-${PROJECT_DIR}/.uap}"
LOG="${STATE_DIR}/read_log.state"

[ -d "$STATE_DIR" ] || mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# SECURITY: never append through a symlink. `>>` follows links, so a symlink
# planted at read_log.state would turn every file read in the session into an
# append to whatever it points at (~/.bashrc), with partly model-supplied
# content — an arbitrary-file-write primitive that escapes workdir-scope
# entirely. Writing the evidence is optional; this is not.
[ -L "$LOG" ] && exit 0

# Store project-relative where possible so entries stay readable across worktrees.
REL="${TARGET#"$PROJECT_DIR"/}"
# SECURITY: a record is "<epoch>\t<path>\n" and TARGET is model-supplied — a Grep
# pattern may legally contain tabs and newlines. Strip the two characters that
# frame a record so a crafted pattern cannot forge additional log entries (and
# thereby forge the gate evidence this file exists to provide).
REL="${REL//$'\t'/ }"
REL="${REL//$'\n'/ }"
REL="${REL//$'\r'/ }"

printf -v NOW '%(%s)T' -1   # bash builtin; no `date` fork
printf '%s\t%s\n' "$NOW" "$REL" >> "$LOG" 2>/dev/null || exit 0

# Same record, in the protected evidence directory. This is the copy the gate
# trusts: self-protect refuses agent writes to .uap/evidence/, while the log
# above sits in the permissive part of .uap/ where a shell append is allowed.
# Written here because a hook is not an agent tool call, so it is not gated.
EVIDENCE_DIR="${STATE_DIR}/evidence"
if [ -d "$EVIDENCE_DIR" ] || mkdir -p "$EVIDENCE_DIR" 2>/dev/null; then
  EVIDENCE="${EVIDENCE_DIR}/reads.log"
  [ -L "$EVIDENCE" ] || printf '%s\t%s\n' "$NOW" "$REL" >> "$EVIDENCE" 2>/dev/null || true
fi

# Bound the file. The enforcer only ever looks at a 30-minute window, so old
# lines are dead weight. Sampled rather than checked every call: reading the log
# on every Read to decide whether to trim costs more than the occasional
# overshoot, and the consumer filters by timestamp anyway.
if (( RANDOM % 50 == 0 )); then
  mapfile -t _lines < "$LOG" 2>/dev/null || exit 0
  if (( ${#_lines[@]} > 400 )); then
    # PID-unique temp: several agents share one project, and a shared temp name
    # lets two concurrent trims interleave into one file and lose entries.
    if printf '%s\n' "${_lines[@]: -200}" > "${LOG}.tmp.$$" 2>/dev/null; then
      mv "${LOG}.tmp.$$" "$LOG" 2>/dev/null || rm -f "${LOG}.tmp.$$" 2>/dev/null
    else
      rm -f "${LOG}.tmp.$$" 2>/dev/null
    fi
  fi
fi

exit 0

#!/usr/bin/env bash
#
# harbor-watchdog.sh — run a harbor benchmark with a stall-watchdog.
#
# The opencode agent intermittently HANGS on some tasks (notably
# sqlite-db-truncate), locking a run for ~50 minutes with no progress before
# harbor's own timeout fires. This wrapper detects a stall — no NEW trial graded
# for STALL_MIN minutes — and kills the active task container so harbor records
# that trial as failed and proceeds to the next. A single hung task no longer
# costs the whole run its wall-clock.
#
# Usage:
#   scripts/benchmarks/harbor-watchdog.sh run -d terminal-bench@2.0 \
#       --agent-import-path ... --job-name myjob --jobs-dir scripts/benchmark-results ...
#
# The wrapper reads --jobs-dir and --job-name from the harbor args to locate the
# results directory. If either is missing it falls back to plain `harbor`.
#
# Env:
#   STALL_MIN  minutes of no-progress before killing the active container (default 22)
#   POLL_SEC   poll interval seconds (default 30)
set -uo pipefail

STALL_MIN="${STALL_MIN:-22}"
POLL_SEC="${POLL_SEC:-30}"

args=("$@")
jobs_dir=""
job_name=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --jobs-dir) jobs_dir="${args[i + 1]:-}" ;;
    --job-name) job_name="${args[i + 1]:-}" ;;
  esac
done

if [[ -z "$jobs_dir" || -z "$job_name" ]]; then
  echo "[watchdog] --jobs-dir/--job-name not found in args — running harbor without watchdog" >&2
  exec harbor "${args[@]}"
fi

JOB="$jobs_dir/$job_name"
echo "[watchdog] stall threshold ${STALL_MIN}min, poll ${POLL_SEC}s, watching $JOB"

harbor "${args[@]}" &
HPID=$!

killed=0
while kill -0 "$HPID" 2>/dev/null; do
  # Stall signal = FILE ACTIVITY, not graded-trial count. A working agent writes
  # command dirs and logs continuously; a hung one writes nothing. (Counting
  # graded trials false-positives: a single long task is "0 graded" until it
  # finishes, which would wrongly look stalled.) If the newest file anywhere in
  # the job tree is older than STALL_MIN, nothing has been written for that long
  # → the active task is hung → kill its container so harbor proceeds.
  newest=$(find "$JOB" -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
  newest=${newest%.*}
  now=$(date +%s)
  if [[ -n "$newest" ]] && (( now - newest >= STALL_MIN * 60 )); then
    c=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '__[A-Za-z0-9]+-main' | head -1)
    if [[ -n "$c" ]]; then
      if docker rm -f "$c" >/dev/null 2>&1; then
        echo "[watchdog $(date +%H:%M)] killed stalled container $c (no file activity for ${STALL_MIN}min)"
        killed=$((killed + 1))
      fi
      sleep 5  # let harbor record the failure / spawn the next container
    fi
  fi
  sleep "$POLL_SEC"
done

wait "$HPID"
rc=$?
echo "[watchdog] harbor exited rc=${rc}; killed ${killed} stalled container(s)"
exit "$rc"

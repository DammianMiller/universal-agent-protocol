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

last=-1
stall=$(date +%s)
killed=0
while kill -0 "$HPID" 2>/dev/null; do
  count=$(ls "$JOB"/*__*/verifier/reward.txt 2>/dev/null | wc -l)
  now=$(date +%s)
  if [[ "$count" != "$last" ]]; then
    last=$count
    stall=$now
  elif (( (now - stall) / 60 >= STALL_MIN )); then
    # No new trial graded for STALL_MIN minutes → kill the active task container.
    c=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '__[A-Za-z0-9]+-main' | head -1)
    if [[ -n "$c" ]]; then
      if docker rm -f "$c" >/dev/null 2>&1; then
        echo "[watchdog $(date +%H:%M)] killed stalled container $c (no progress for ${STALL_MIN}min at ${count} graded)"
        killed=$((killed + 1))
      fi
      stall=$(date +%s)
    fi
  fi
  sleep "$POLL_SEC"
done

wait "$HPID"
rc=$?
echo "[watchdog] harbor exited rc=${rc}; killed ${killed} stalled container(s)"
exit "$rc"

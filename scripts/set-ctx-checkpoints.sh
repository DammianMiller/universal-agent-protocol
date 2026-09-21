#!/usr/bin/env bash
#
# set-ctx-checkpoints.sh — retune --ctx-checkpoints on the GSQ-RCO unit.
#
#   bash scripts/set-ctx-checkpoints.sh 3        # stage the change
#   bash scripts/set-ctx-checkpoints.sh 3 --now  # stage AND restart the server
#
# WHY YOU MIGHT WANT THIS
# -----------------------
# Checkpoints are charged to the SAME VBR KV budget as live context
# (--vbr-vram 5120M), at roughly 190 MiB each, PER SLOT. With 2 rails:
#
#     4 per slot  ->  4 x 2 x 190 =  1520 MiB   (30% of the budget)
#     3 per slot  ->  3 x 2 x 190 =  1140 MiB   (22%)
#     2 per slot  ->  2 x 2 x 190 =   760 MiB   (15%)
#
# Measured 2026-09-21 at 4-per-slot after ~6h uptime: kv_bpv sat at 4.219
# against a floor of 4.125 — i.e. the cache had degraded to its lowest quality
# tier because checkpoints had eaten a third of the budget. Dropping to 3
# returns ~380 MiB to live KV.
#
# THE TRADE, so it is a decision and not a knob
# ---------------------------------------------
# Checkpoints are what let a turn restore a long prefix instead of re-prefilling
# it. Going 1 -> 4 on 2026-09-21 took checkpoint recovery from 20% to 69% of the
# reusable prefix, which is worth roughly 32k tokens of prefill PER TURN. Give
# some of that back and re-prefill cost rises; keep it and KV quality stays at
# the floor. There is no free direction — pick the one your workload feels.
#
# Check the effect with:  uap inference health
#   - `reuse NN% of the reusable prefix restored`  <- checkpoint value
#   - `kv N.NNN bpv (floor 4.125)`                 <- KV quality headroom
#
set -euo pipefail

UNIT_FILE="$HOME/.config/systemd/user/uap-gsq-rco-server.service"
UNIT="uap-gsq-rco-server.service"
N="${1:-}"
RESTART="${2:-}"

[[ "$N" =~ ^[1-9][0-9]*$ ]] || {
  echo "usage: $0 <checkpoints-per-slot> [--now]" >&2
  echo "       e.g. $0 3        (stage only)" >&2
  echo "            $0 3 --now  (stage and restart)" >&2
  exit 2
}
[ -f "$UNIT_FILE" ] || { echo "ERROR: no unit at $UNIT_FILE" >&2; exit 1; }

CURRENT=$(grep -oE -- '--ctx-checkpoints [0-9]+' "$UNIT_FILE" \
          | grep -v '^\s*#' | tail -1 | awk '{print $2}')
[ -n "$CURRENT" ] || { echo "ERROR: could not read the current --ctx-checkpoints" >&2; exit 1; }

if [ "$CURRENT" = "$N" ]; then
  echo "already at --ctx-checkpoints $N — nothing to do"
  exit 0
fi

BAK="$UNIT_FILE.bak-ctxcp${CURRENT}-$(date +%Y%m%d-%H%M%S)"
cp -p "$UNIT_FILE" "$BAK"
echo "backed up -> $BAK"

# Only the live flag line; the comment history says 4 in several places and
# must not be rewritten.
python3 - "$UNIT_FILE" "$CURRENT" "$N" <<'PY'
import sys, pathlib
path, cur, new = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
out, hits = [], 0
for line in p.read_text().splitlines(keepends=True):
    if not line.lstrip().startswith('#') and f'--ctx-checkpoints {cur}' in line:
        line = line.replace(f'--ctx-checkpoints {cur}', f'--ctx-checkpoints {new}')
        hits += 1
    out.append(line)
if hits != 1:
    sys.exit(f"ERROR: expected exactly 1 live flag line, changed {hits}")
p.write_text(''.join(out))
print(f"  --ctx-checkpoints {cur} -> {new}")
PY

python3 -c "
c,n=int('$CURRENT'),int('$N')
d=(c-n)*2*190
print(f\"  VBR budget: {'frees' if d>0 else 'costs'} ~{abs(d)} MiB (2 rails x ~190 MiB each)\")"

systemctl --user daemon-reload
echo "daemon reloaded — change is STAGED"

if [ "$RESTART" = "--now" ]; then
  echo
  echo "restarting $UNIT (drops in-flight requests)..."
  systemctl --user restart "$UNIT"
  for i in $(seq 1 60); do
    curl -fsS -m 3 http://127.0.0.1:8080/health >/dev/null 2>&1 && { echo "  healthy after ~$((i*3))s"; break; }
    sleep 3
  done
  echo
  curl -s -m 10 http://127.0.0.1:8080/slots 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  slots={len(d)}  n_ctx={d[0][\"n_ctx\"]:,}  kv_bpv={d[0].get(\"kv_bpv\")}')" || true
  nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader 2>/dev/null | sed 's/^/  vram: /'
  echo
  echo "now check:  uap inference health"
else
  echo
  echo "NOT restarted. The running server still has --ctx-checkpoints $CURRENT."
  echo "Apply at your convenience:"
  echo "    systemctl --user restart $UNIT"
  echo "Then:"
  echo "    uap inference health"
  echo "Revert:  cp $BAK $UNIT_FILE && systemctl --user daemon-reload"
fi

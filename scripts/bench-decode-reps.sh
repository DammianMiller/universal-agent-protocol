#!/usr/bin/env bash
# Honest decode measurement for the local server.
#
# Exists because a single rep on "count from 1 to 40" reported 71.96 tok/s at
# 90.4% draft acceptance — both inflated. Counting is near-perfectly draftable,
# so speculative decode lands nearly every token. Real prose is not. Always
# measure with a mix, and report the prose number as the characteristic one.
set -uo pipefail

URL="${URL:-http://127.0.0.1:8080/v1/chat/completions}"
MODEL="${MODEL:-qwen38-gsq-rco-27b}"
REPS="${REPS:-3}"
MAXTOK="${MAXTOK:-220}"

run_one() { # <label> <prompt>
  local label=$1 prompt=$2 out
  out=$(curl -s --max-time 300 "$URL" -H 'Content-Type: application/json' \
    -d "$(python3 -c "
import json,sys
print(json.dumps({
  'model': '$MODEL',
  'messages': [{'role':'user','content': sys.argv[1]}],
  'max_tokens': $MAXTOK,
  'temperature': 0,
}))" "$prompt")")
  python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
t=d.get('timings') or {}
u=d.get('usage') or {}
dn=t.get('draft_n') or 0
da=t.get('draft_n_accepted') or 0
acc=(da/dn) if dn else float('nan')
print('  %-22s tok/s=%6.1f  predicted=%4d  draft=%4d/%-4d acc=%s' % (
    '$label', t.get('predicted_per_second') or 0,
    u.get('completion_tokens') or 0, da, dn,
    ('%.1f%%'%(acc*100)) if dn else 'n/a'))
" <<<"$out"
}

echo "=== decode reps (max_tokens=$MAXTOK, temp=0, $REPS reps each) ==="
echo
echo "A. degenerate / highly draftable (what the inflated number came from):"
for i in $(seq 1 "$REPS"); do
  run_one "count-to-40 #$i" "Count from 1 to 40, separated by spaces. Output only the numbers."
done

echo
echo "B. real prose (the characteristic case):"
for i in $(seq 1 "$REPS"); do
  run_one "prose #$i" "Explain, in about 200 words of flowing prose, why speculative decoding improves throughput on a memory-bandwidth-bound GPU, and what limits the speedup."
done

echo
echo "C. code generation (typical agent work):"
for i in $(seq 1 "$REPS"); do
  run_one "code #$i" "Write a Python function that merges two sorted lists into one sorted list, with a docstring and two edge-case comments. Output only code."
done

echo
echo "=== VRAM now ==="
nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader 2>/dev/null \
  | grep -i llama || nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader | head -3
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader

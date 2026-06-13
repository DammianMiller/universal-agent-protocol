#!/usr/bin/env bash
# Smoke-test the PROXY_THINKING_GRAMMAR toggle by sending the courier
# planning puzzle through the running proxy. Compare a baseline run
# (toggle off) against a thinking-grammar run (toggle on). Expected
# correct conclusion is "NO VALID ROUTE EXISTS".
#
# Usage:
#   PROXY_URL=http://127.0.0.1:4000 MODEL=qwen35-a3b-iq4xs ./scripts/test-thinking-grammar-puzzle.sh
#
# Pre-requisites:
#   - llama-server running upstream
#   - anthropic_proxy.py running with PROXY_THINKING_GRAMMAR set as desired
set -euo pipefail

PROXY_URL="${PROXY_URL:-http://127.0.0.1:4000}"
MODEL="${MODEL:-qwen35-a3b-iq4xs}"
OUT_DIR="${OUT_DIR:-/tmp/grammar-test}"
mkdir -p "$OUT_DIR"

read -r -d '' PUZZLE <<'EOF' || true
You are given a constrained planning problem. Think carefully, verify each condition, and do not skip impossibility checks.
Problem:
A courier starts at point S and must visit exactly once each of the locations A, B, C, D, and E, then end at T.
Travel times (in minutes) are symmetric:
S-A 4, S-B 6, S-C 8, S-D 7, S-E 9
A-B 5, A-C 7, A-D 3, A-E 8
B-C 4, B-D 6, B-E 5
C-D 5, C-E 3
D-E 6
A-T 8, B-T 6, C-T 5, D-T 7, E-T 4
Constraints:
1. C cannot be visited before B.
2. D must be visited immediately after A.
3. E cannot be the last location before T.
4. Total travel time must be less than 28 minutes.
5. Exactly one of these must be true:
   - B is visited second
   - C is visited fourth
6. If A is visited first, then B must be visited third.
7. The route must include at least one step whose travel time is exactly 3 minutes.
Task:
Determine whether a valid route exists.
- If it exists, provide one valid route and its total time.
- If it does not exist, prove why no valid route can satisfy all constraints.
- Show your reasoning clearly and check every constraint explicitly.
- Do not guess. If multiple routes seem possible, test them against all rules before concluding.
Output format:
1. Conclusion: VALID ROUTE EXISTS / NO VALID ROUTE EXISTS
2. Route: ...
3. Total time: ...
4. Constraint check: ...
5. Brief proof: ...
EOF

PAYLOAD=$(jq -nc --arg model "$MODEL" --arg content "$PUZZLE" '{
  model: $model,
  max_tokens: 4096,
  temperature: 0.3,
  messages: [{role:"user", content:$content}]
}')

LABEL="${1:-result}"
OUT="$OUT_DIR/${LABEL}.json"
echo "[puzzle] POST $PROXY_URL/v1/messages model=$MODEL label=$LABEL"
curl -s --max-time 1200 -X POST "$PROXY_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d "$PAYLOAD" > "$OUT"

echo "[puzzle] saved $(wc -c < "$OUT") bytes -> $OUT"
TEXT=$(jq -r '.content[0].text // .content // .' "$OUT" 2>/dev/null || cat "$OUT")
CONCLUSION=$(echo "$TEXT" | grep -oE '(NO VALID ROUTE EXISTS|VALID ROUTE EXISTS)' | head -1)
echo "[puzzle] conclusion: ${CONCLUSION:-<unparseable>}"
if [[ "$CONCLUSION" == "NO VALID ROUTE EXISTS" ]]; then
  echo "[puzzle] PASS"
  exit 0
fi
echo "[puzzle] FAIL (expected NO VALID ROUTE EXISTS)"
exit 1

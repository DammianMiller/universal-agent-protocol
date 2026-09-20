#!/usr/bin/env bash
#
# Assert that the per-session context cap is actually in force.
#
# The 2-rail setup depends on it: the server's 229376 is a SHARED pool
# (kv_unified), the proxy detects that number and hands it to every session,
# and the ONLY thing pinning a session below it is a model profile's
# context_window, selected by the x-uap-model-profile header. If that header
# is not honoured, two concurrent agents overcommit the pool.
#
# An earlier version of this script printed four curl results and exited 0
# unconditionally — a diagnostic transcript wearing a verifier's name. Worse,
# it queried /v1/context with NO session_id, so the proxy fell back to whichever
# session last touched it, and on a miss fabricates a monitor carrying the
# UNCAPPED global default — which reads as "the profile was ignored" even when
# it was honoured. Both are fixed: the probe's own session is addressed by id,
# and every check asserts.
#
# Exits non-zero on any failure, so it can gate.
set -uo pipefail

PROXY="${PROXY:-http://127.0.0.1:4000}"
DIRECT="${DIRECT:-http://127.0.0.1:8080}"
PROFILE="${PROFILE:-qwen38}"
OC_GLOBAL="$HOME/.config/opencode/opencode.json"

fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

# Token scoped to the qwen-proxy provider; passed to curl via a config file on
# stdin, never on argv (/proc here is mounted without hidepid).
TOKEN=$(python3 - "$OC_GLOBAL" <<'PY' 2>/dev/null || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    k = ((d.get("provider", {}).get("qwen-proxy") or {}).get("options") or {}).get("apiKey")
    if k and not str(k).startswith("{env:"):
        print(k)
except Exception:
    pass
PY
)

curl_auth() { # <curl args...>  — token supplied out-of-band
  printf 'header = "x-uap-proxy-token: %s"\n' "$TOKEN" | curl -sS --config - "$@"
}

echo "== 1. what the SERVER exposes =="
slots_json=$(curl -sS -m 5 "$DIRECT/slots" 2>/dev/null || true)
read -r n_slots pool <<<"$(printf '%s' "$slots_json" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print(len(d), d[0].get('n_ctx',0))
except Exception: print(0,0)
")"
echo "   slots=$n_slots  n_ctx=$pool (shared pool)"
[ "$n_slots" -ge 1 ] 2>/dev/null && ok "server reachable, $n_slots slot(s)" \
  || { bad "could not read /slots from $DIRECT"; echo; exit 1; }

echo
echo "== 2. send a request WITH the profile header =="
SESS="profile-probe-$(date +%s)-$$"
resp=$(curl_auth -m 120 "$PROXY/v1/messages" \
  -H 'Content-Type: application/json' \
  -H "x-uap-model-profile: $PROFILE" \
  -H "x-session-id: $SESS" \
  -d '{"model":"Qwen3.8-27B","max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: PROBE_OK"}]}' 2>/dev/null || true)
if printf '%s' "$resp" | grep -q 'PROBE_OK'; then
  ok "proxy answered the profiled request"
else
  bad "no usable response: $(printf '%s' "$resp" | head -c 200)"
fi

echo
echo "== 3. the cap actually applied to THIS session =="
# Address the probe's own monitor. The proxy stores it under the "hdr:" prefix,
# and without the query param it would report some other session's window.
ctx=$(curl_auth -m 10 "$PROXY/v1/context?session_id=hdr:$SESS" 2>/dev/null || true)
win=$(printf '%s' "$ctx" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('context_window',0))
except Exception: print(0)
")
sid=$(printf '%s' "$ctx" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('active_session_id',''))
except Exception: print('')
")
echo "   session      : $sid"
echo "   window       : $win"
echo "   shared pool  : $pool"

if [ "$sid" != "hdr:$SESS" ]; then
  bad "reported session '$sid' is not this probe's ('hdr:$SESS') — the window above describes someone else"
else
  ok "reported window belongs to this probe's session"
fi

if [ "$win" -gt 0 ] 2>/dev/null && [ "$win" -lt "$pool" ] 2>/dev/null; then
  ok "session capped BELOW the shared pool ($win < $pool)"
else
  bad "session window $win is NOT below the pool $pool — the cap is not in force; two concurrent agents would overcommit"
fi

echo
echo "== 4. what discovery advertises (known gap, informational) =="
adv=$(curl_auth -m 10 "$PROXY/v1/models" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for m in (d.get('data') or []):
        if 'qwen' in (m.get('id') or '').lower():
            print(m.get('context_window') or 0); break
    else: print(0)
except Exception: print(0)
")
echo "   /v1/models advertises: $adv"
if [ "$adv" != "$win" ]; then
  printf '  \033[33mNOTE\033[0m /v1/models advertises %s, not the per-session cap %s.\n' "$adv" "$win"
  echo "       _model_entry uses the PROCESS window and is profile-blind, so a"
  echo "       client that sizes itself from discovery rather than its own"
  echo "       config will still aim at the pool. Clients configured by"
  echo "       scripts/sync-local-agent-configs.sh carry explicit limits."
fi

echo
if [ "$fail" = "0" ]; then
  echo "PER-SESSION CAP VERIFIED"
else
  echo "VERIFICATION FAILED"
fi
exit "$fail"

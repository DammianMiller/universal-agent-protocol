#!/usr/bin/env bash
# Prove sync-local-agent-configs.sh against SYNTHETIC configs.
#
# Builds a throwaway $HOME, runs the real installer into it, and asserts the
# result. Touches nothing outside the sandbox and depends on nothing about the
# operator's own machine — an earlier version seeded from the real $HOME and
# hardcoded that operator's codex default, so it reported failures on any other
# box and its token assertions passed only by luck.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The alias the installer must write, read from the profile the same way the
# installer reads it — reality-derived, never transcribed here.
ALIAS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["model"])' \
  "$HERE/../config/model-profiles/qwen38.json") \
  || { echo "sandbox: cannot read the profile alias"; exit 1; }
[ -n "$ALIAS" ] || { echo "sandbox: profile alias is empty"; exit 1; }
# Expected rail count likewise: the profile's parallel_rails is the reality the
# proxy env must converge on (2 in the llama.cpp era, 1 in the strata era).
RAILS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["server_optimization"]["parallel_rails"])' \
  "$HERE/../config/model-profiles/qwen38.json") \
  || { echo "sandbox: cannot read the profile rail count"; exit 1; }
[ -n "$RAILS" ] || { echo "sandbox: profile rail count is empty"; exit 1; }
# Session cap and pool likewise — transcribed numbers here are what left this
# suite red on master through the whole 1-rail era.
CTX=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["context_window"])' \
  "$HERE/../config/model-profiles/qwen38.json") \
  || { echo "sandbox: cannot read the profile session cap"; exit 1; }
POOL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["server_optimization"]["kv_capacity"])' \
  "$HERE/../config/model-profiles/qwen38.json") \
  || { echo "sandbox: cannot read the profile pool"; exit 1; }
[ -n "$CTX" ] && [ -n "$POOL" ] || { echo "sandbox: profile cap/pool empty"; exit 1; }
# Pin TMPDIR: it is honoured by mktemp, and a TMPDIR pointing inside the repo
# would drop generated configs into the worktree.
SANDBOX=$(TMPDIR=/tmp mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT INT TERM

FAKE_TOKEN="sk-sandbox-TOKEN-do-not-ship"
CLOUD_KEY="sk-ant-SANDBOX-CLOUD-KEY"

mkdir -p "$SANDBOX/.config/opencode" "$SANDBOX/.config/uap" \
         "$SANDBOX/.factory" "$SANDBOX/.codex" "$SANDBOX/.local/bin"

# --- synthetic fixtures, shaped like the real thing -----------------------
# A CLOUD provider is deliberately placed FIRST, and a cloud-pinned agent is
# included: the installer must capture neither.
cat > "$SANDBOX/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "theme": "keep-me",
  "provider": {
    "anthropic": { "options": { "apiKey": "$CLOUD_KEY" } },
    "qwen-proxy": { "options": { "apiKey": "$FAKE_TOKEN" } }
  },
  "agent": {
    "build":    { "model": "qwen-proxy/Qwen3.8-27B", "temperature": 0.1 },
    "reviewer": { "model": "anthropic/claude-opus-4-5", "temperature": 0.2 }
  },
  "small_model": "llama.cpp/qwen35-a3b-iq4xs"
}
EOF

cat > "$SANDBOX/.config/uap/anthropic-proxy.env" <<'EOF'
PROXY_PORT=4000
PROXY_CONCURRENCY_LIMIT=1
UAP_MODEL_SLOTS=1
PROXY_SESSION_ADMISSION_LIMIT=4
PROXY_CONTEXT_WINDOW=229376
PROXY_LOG_LEVEL=INFO
EOF

cat > "$SANDBOX/.factory/config.json" <<'EOF'
{ "custom_models": [
  { "model_display_name": "Qwen3.5", "model": "qwen35-a3b-iq4xs",
    "base_url": "http://localhost:8080/v1", "api_key": "**********", "provider": "openai" },
  { "model_display_name": "Qwen3.8-27B GSQ-RCO (local)", "model": "qwen38-gsq-rco-27b",
    "base_url": "http://127.0.0.1:4000/v1", "api_key": "stale", "provider": "openai" },
  { "model_display_name": "CC Opus", "model": "claude-opus-4-6",
    "base_url": "http://192.168.1.165:8317", "api_key": "local", "provider": "anthropic" }
] }
EOF
# settings.json uses the camelCase spelling AND has an entry with no `model`
# key at all — the shape that used to raise TypeError mid-run.
cat > "$SANDBOX/.factory/settings.json" <<'EOF'
{ "customModels": [
  { "displayName": "Qwen3.5 Proxy", "model": "qwen35-a3b-iq4xs", "id": "custom:q-27",
    "baseUrl": "http://localhost:4000", "apiKey": "not-needed", "noImageSupport": true },
  { "displayName": "Qwen3.8-27B GSQ-RCO (local)", "model": "qwen38-gsq-rco-27b",
    "baseUrl": "http://127.0.0.1:4000/v1", "apiKey": "stale" },
  { "displayName": "Odd entry", "baseUrl": "http://192.168.1.165:8317" }
] }
EOF

cat > "$SANDBOX/.codex/config.toml" <<'EOF'
model = "some-cloud-model"
[tui]
status_line = ["model-name"]

# --- UAP local stack (added 2026-09-20 by sync-local-agent-configs.sh) ------
# Exactly the block an older run of the installer wrote (chat wire, proxy
# route, retired id). The current run must REPLACE it wholesale — codex 0.120
# refuses to load a config carrying wire_api = "chat" at all.
[model_providers.uap-local]
name = "UAP anthropic-proxy (local Qwen3.8-27B GSQ-RCO)"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "chat"

[model_providers.uap-local.http_headers]
x-uap-model-profile = "qwen38"

[profiles.qwen38]
model = "qwen38-gsq-rco-27b"
model_provider = "uap-local"
EOF

echo "sandbox: $SANDBOX"
echo "=========================== RUN ==========================="
# SKIP_SERVICE_OPS: systemctl --user is per-USER, not per-$HOME, so a fake HOME
# does NOT isolate it — without this the test restarts the operator's proxy.
SKIP_SERVICE_OPS=1 HOME="$SANDBOX" bash "$HERE/sync-local-agent-configs.sh" 2>&1 | sed 's/^/  | /'
RUN_RC=${PIPESTATUS[0]}

echo
echo "========================= ASSERTIONS ======================="
fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

[ "$RUN_RC" = "0" ] && ok "installer exited 0" || bad "installer exited $RUN_RC"

# 1. proxy env
env_f="$SANDBOX/.config/uap/anthropic-proxy.env"
grep -q "^PROXY_CONCURRENCY_LIMIT=$RAILS$"      "$env_f" && ok "proxy: concurrency -> $RAILS"      || bad "proxy: concurrency not $RAILS"
grep -q "^UAP_MODEL_SLOTS=$RAILS$"              "$env_f" && ok "proxy: model slots -> $RAILS"      || bad "proxy: slots not $RAILS"
grep -q "^PROXY_SESSION_ADMISSION_LIMIT=$RAILS$" "$env_f" && ok "proxy: admission -> $RAILS (pool guard)" || bad "proxy: admission limit not $RAILS"
grep -q "^PROXY_CONTEXT_WINDOW=$CTX$"    "$env_f" && ok "proxy: fallback window $CTX (profile cap)" || bad "proxy: fallback window wrong"
grep -q '^PROXY_LOG_LEVEL=INFO$'           "$env_f" && ok "proxy: unrelated keys preserved" || bad "proxy: clobbered other keys"
[ "$(grep -c '^PROXY_CONCURRENCY_LIMIT=' "$env_f")" = "1" ] && ok "proxy: no duplicate keys" || bad "proxy: duplicated key"

# 2. opencode — including what must NOT change
python3 - "$SANDBOX/.config/opencode/opencode.json" "$FAKE_TOKEN" "$CLOUD_KEY" "$ALIAS" "$CTX" "$POOL" <<'PY' && ok "opencode: shape, scoping and preservation" || bad "opencode: assertions failed"
import json,sys
d=json.load(open(sys.argv[1])); tok, cloud, alias, ctx, pool = sys.argv[2:7]
ctx, pool = int(ctx), int(pool)
p=d["provider"]["qwen-proxy"]; m=p["models"]["Qwen3.8-27B"]
assert p["options"]["baseURL"]=="http://127.0.0.1:4000/v1"
assert p["options"]["headers"]["x-uap-model-profile"]=="qwen38"
assert m["limit"]=={"context":ctx,"output":32768}, m["limit"]
assert m["reasoning"] is True
# The token must come from qwen-proxy, NOT the cloud provider listed first.
assert p["options"]["apiKey"]==tok, f"expected scoped token, got {p['options']['apiKey']!r}"
assert p["options"]["headers"]["x-uap-proxy-token"]==tok
# The cloud provider keeps its OWN key — the script must not delete the user's
# entry — but that key must never be copied into the local plumbing.
assert d["provider"]["anthropic"]["options"]["apiKey"]==cloud, "clobbered the cloud provider's own key"
assert cloud not in json.dumps(p), "CLOUD KEY copied into the qwen-proxy provider"
assert cloud not in json.dumps(d["provider"]["llama.cpp-direct"]), "CLOUD KEY copied into the direct provider"
# cloud-pinned agent must survive; local one must be repointed
assert d["agent"]["reviewer"]["model"]=="anthropic/claude-opus-4-5", "clobbered a cloud-pinned agent"
assert d["agent"]["build"]["model"]=="qwen-proxy/Qwen3.8-27B"
# dangling reference to the removed provider must be repaired
assert d["small_model"]=="qwen-proxy/Qwen3.8-27B", d["small_model"]
assert d.get("theme")=="keep-me", "unrelated settings lost"
# the direct escape hatch is keyed by the id actually served
assert d["provider"]["llama.cpp-direct"]["models"][alias]["limit"]["context"]==pool, \
    "direct path not keyed by the served alias (or not sized to the pool)"
assert "llama.cpp" not in d["provider"]
PY

# 3. factory — including the entry with no `model` key
for F in config.json settings.json; do
  python3 - "$SANDBOX/.factory/$F" "$FAKE_TOKEN" "$ALIAS" <<'PY' && ok "factory/$F: repointed, no crash" || bad "factory/$F: assertions failed"
import json,sys
d=json.load(open(sys.argv[1])); tok=sys.argv[2]; alias=sys.argv[3]
found=0
for key in ("custom_models","customModels"):
    for m in d.get(key,[]) or []:
        assert m.get("model") not in ("qwen35-a3b-iq4xs","qwen38-gsq-rco-27b"), "retired model id still present"
        if m.get("model")==alias:
            found+=1
            assert not m.get("noImageSupport"), "vision still disabled"
            for bk in ("base_url","baseUrl"):
                if bk in m: assert m[bk]=="http://127.0.0.1:4000/v1", m[bk]
            for ak in ("api_key","apiKey"):
                if ak in m: assert m[ak]==tok, m[ak]
        for bk in ("base_url","baseUrl"):
            v=m.get(bk)
            assert not (isinstance(v,str) and "192.168.1.165:8317" in v), "LAN 8317 split-brain remains"
assert found>=1, "no repointed local entry found"
PY
done

# 4. codex — additive, converging, loadable, idempotent
c="$SANDBOX/.codex/config.toml"
grep -q '^\[model_providers.uap-local\]'        "$c" && ok "codex: local provider present" || bad "codex: provider missing"
grep -q '^\[profiles.qwen38\]'                  "$c" && ok "codex: qwen38 profile present"  || bad "codex: profile missing"
grep -q '^wire_api = "responses"$'              "$c" && ok "codex: speaks the Responses API (0.120 requirement)" || bad "codex: wire_api not responses — config will not load"
grep -q '^base_url = "http://127.0.0.1:8080/v1"$' "$c" && ok "codex: direct strata route (proxy has no /v1/responses)" || bad "codex: not on the direct responses route"
grep -Fq "model = \"$ALIAS\""                   "$c" && ok "codex: profile model is the served alias" || bad "codex: profile model is not the served alias"
grep -q "^model_context_window = $CTX$"         "$c" && ok "codex: per-session cap carried client-side ($CTX)" || bad "codex: no client-side context cap"
grep -q '^model = "some-cloud-model"'           "$c" && ok "codex: existing default untouched" || bad "codex: default model changed!"
grep -q 'qwen38-gsq-rco-27b'                    "$c" && bad "codex: retired id still present" || ok "codex: retired id gone"
[ "$(grep -c '^\[profiles.qwen38\]' "$c")" = "1" ] && ok "codex: single profile block (no duplicates)" || bad "codex: duplicated the block"

# 5. claude-local: mode, no embedded secret, header
w="$SANDBOX/.local/bin/claude-local"
[ -x "$w" ] && ok "claude-local: created and executable" || bad "claude-local: missing/not executable"
mode=$(stat -c '%a' "$w" 2>/dev/null || echo "?")
[ "$mode" = "700" ] && ok "claude-local: mode 700 (not group-writable on PATH)" || bad "claude-local: mode $mode, expected 700"
grep -q "$FAKE_TOKEN" "$w" && bad "claude-local: TOKEN IS EMBEDDED in the wrapper" || ok "claude-local: no embedded secret"
grep -q 'ANTHROPIC_CUSTOM_HEADERS' "$w" && ok "claude-local: sends the profile header (cap applies)" || bad "claude-local: no profile header -> uncapped"
grep -Fq "ANTHROPIC_MODEL=\"\${ANTHROPIC_MODEL:-$ALIAS}\"" "$w" && ok "claude-local: ANTHROPIC_MODEL is the served alias" || bad "claude-local: ANTHROPIC_MODEL is not the served alias"

# 6. idempotence
SKIP_SERVICE_OPS=1 HOME="$SANDBOX" bash "$HERE/sync-local-agent-configs.sh" >/dev/null 2>&1
rc2=$?
[ "$rc2" = "0" ] && ok "second run also exits 0" || bad "second run exited $rc2"
[ "$(grep -c '^\[profiles.qwen38\]' "$c")" = "1" ] && ok "codex: idempotent (no duplicate append)" || bad "codex: duplicated on re-run"
[ "$(grep -c '^PROXY_CONCURRENCY_LIMIT=' "$env_f")" = "1" ] && ok "proxy: idempotent" || bad "proxy: duplicated on re-run"
tok2=$(python3 -c "
import json;d=json.load(open('$SANDBOX/.config/opencode/opencode.json'))
print(d['provider']['qwen-proxy']['options']['apiKey'])")
[ "$tok2" = "$FAKE_TOKEN" ] && ok "token stable across runs (no drift to a placeholder)" || bad "token drifted to '$tok2'"

# 7. refuses to report success with no proxy env
S2=$(TMPDIR=/tmp mktemp -d); mkdir -p "$S2/.config/opencode"
if SKIP_SERVICE_OPS=1 HOME="$S2" bash "$HERE/sync-local-agent-configs.sh" >/dev/null 2>&1; then
  bad "missing proxy env: exited 0 (would report success having skipped the whole point)"
else
  ok "missing proxy env: fails loudly instead of reporting success"
fi
rm -rf "$S2"

echo
[ "$fail" = "0" ] && echo "ALL ASSERTIONS PASSED" || { echo "SOME ASSERTIONS FAILED"; exit 1; }

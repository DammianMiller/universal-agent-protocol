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
    "base_url": "http://localhost:8080/v1", "api_key": "sk-qwen35b", "provider": "openai" },
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
  { "displayName": "Odd entry", "baseUrl": "http://192.168.1.165:8317" }
] }
EOF

cat > "$SANDBOX/.codex/config.toml" <<'EOF'
model = "some-cloud-model"
[tui]
status_line = ["model-name"]
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
grep -q '^PROXY_CONCURRENCY_LIMIT=2$'      "$env_f" && ok "proxy: concurrency -> 2"      || bad "proxy: concurrency not 2"
grep -q '^UAP_MODEL_SLOTS=2$'              "$env_f" && ok "proxy: model slots -> 2"      || bad "proxy: slots not 2"
grep -q '^PROXY_SESSION_ADMISSION_LIMIT=2$' "$env_f" && ok "proxy: admission 4 -> 2 (pool guard)" || bad "proxy: admission limit not 2"
grep -q '^PROXY_CONTEXT_WINDOW=114688$'    "$env_f" && ok "proxy: fallback window 114688" || bad "proxy: fallback window wrong"
grep -q '^PROXY_LOG_LEVEL=INFO$'           "$env_f" && ok "proxy: unrelated keys preserved" || bad "proxy: clobbered other keys"
[ "$(grep -c '^PROXY_CONCURRENCY_LIMIT=' "$env_f")" = "1" ] && ok "proxy: no duplicate keys" || bad "proxy: duplicated key"

# 2. opencode — including what must NOT change
python3 - "$SANDBOX/.config/opencode/opencode.json" "$FAKE_TOKEN" "$CLOUD_KEY" <<'PY' && ok "opencode: shape, scoping and preservation" || bad "opencode: assertions failed"
import json,sys
d=json.load(open(sys.argv[1])); tok, cloud = sys.argv[2], sys.argv[3]
p=d["provider"]["qwen-proxy"]; m=p["models"]["Qwen3.8-27B"]
assert p["options"]["baseURL"]=="http://127.0.0.1:4000/v1"
assert p["options"]["headers"]["x-uap-model-profile"]=="qwen38"
assert m["limit"]=={"context":114688,"output":32768}, m["limit"]
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
assert "llama.cpp" not in d["provider"]
PY

# 3. factory — including the entry with no `model` key
for F in config.json settings.json; do
  python3 - "$SANDBOX/.factory/$F" "$FAKE_TOKEN" <<'PY' && ok "factory/$F: repointed, no crash" || bad "factory/$F: assertions failed"
import json,sys
d=json.load(open(sys.argv[1])); tok=sys.argv[2]
found=0
for key in ("custom_models","customModels"):
    for m in d.get(key,[]) or []:
        assert m.get("model")!="qwen35-a3b-iq4xs", "retired model id still present"
        if m.get("model")=="qwen38-gsq-rco-27b":
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

# 4. codex — additive, header-carrying, idempotent
c="$SANDBOX/.codex/config.toml"
grep -q '^\[model_providers.uap-local\]'        "$c" && ok "codex: local provider added" || bad "codex: provider missing"
grep -q '^\[profiles.qwen38\]'                  "$c" && ok "codex: qwen38 profile added"  || bad "codex: profile missing"
grep -q '^x-uap-model-profile = "qwen38"'       "$c" && ok "codex: sends the profile header (cap applies)" || bad "codex: no profile header -> uncapped"
grep -q '^model = "some-cloud-model"'           "$c" && ok "codex: existing default untouched" || bad "codex: default model changed!"

# 5. claude-local: mode, no embedded secret, header
w="$SANDBOX/.local/bin/claude-local"
[ -x "$w" ] && ok "claude-local: created and executable" || bad "claude-local: missing/not executable"
mode=$(stat -c '%a' "$w" 2>/dev/null || echo "?")
[ "$mode" = "700" ] && ok "claude-local: mode 700 (not group-writable on PATH)" || bad "claude-local: mode $mode, expected 700"
grep -q "$FAKE_TOKEN" "$w" && bad "claude-local: TOKEN IS EMBEDDED in the wrapper" || ok "claude-local: no embedded secret"
grep -q 'ANTHROPIC_CUSTOM_HEADERS' "$w" && ok "claude-local: sends the profile header (cap applies)" || bad "claude-local: no profile header -> uncapped"

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

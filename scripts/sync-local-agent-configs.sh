#!/usr/bin/env bash
#
# sync-local-agent-configs.sh — point every coding agent at the live local stack.
#
#   Server : uap-gsq-rco-server.service  (Qwen3.8-27B GSQ-RCO, buun-llama-cpp)
#            -np 2 -c 229376, kv_unified=true  ->  ONE 229376-cell SHARED pool.
#            -np does NOT divide the context: /slots reports n_ctx=229376 for
#            BOTH slots and either rail may address all of it.
#   Proxy  : uap-anthropic-proxy.service on :4000
#   Profile: config/model-profiles/qwen38.json  (per-session window 114688)
#
# WHY A PER-SESSION CAP IS NEEDED
# --------------------------------
# anthropic_proxy.py detects n_ctx from /slots and that detection OVERWRITES
# both default_context_window AND every live session monitor (:3241-3245), so
# PROXY_CONTEXT_WINDOW is NOT a backstop — it is replaced within one recheck
# interval. The only thing that pins a session below the pool is a model
# profile's context_window, selected per request by the x-uap-model-profile
# header. Every client configured here therefore sends that header.
#
# WHY THIS IS A SCRIPT AND NOT AGENT EDITS
# ----------------------------------------
# Everything here writes OUTSIDE the project root (~/.config, ~/.factory,
# ~/.codex, ~/.local/bin) or touches the proxy env. The UAP "Enforcement
# Self-Protect" policy blocks the agent from both, and deliberately refuses the
# workdir-gate override too (rule 2). Operator override is out-of-band only, so
# this runs from YOUR shell. It is idempotent: safe to re-run.
#
#   bash scripts/sync-local-agent-configs.sh            # apply
#   DRY_RUN=1 bash scripts/sync-local-agent-configs.sh  # show, change nothing
#   SKIP_SERVICE_OPS=1 ...                              # no systemctl/curl
#
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$HOME/.uap-backups/agent-config-sync-$STAMP"
DRY_RUN="${DRY_RUN:-0}"

# --- the single source of truth for every client ---------------------------
PROXY_URL="http://127.0.0.1:4000"
DIRECT_URL="http://127.0.0.1:8080"
PROFILE_NAME="qwen38"
PROFILE_HEADER="x-uap-model-profile"
MAX_OUTPUT=32768         # matches the proxy tool-turn cap (proxy env, not profile geometry)

PROXY_ENV="$HOME/.config/uap/anthropic-proxy.env"
OC_GLOBAL="$HOME/.config/opencode/opencode.json"
FACTORY_CFG="$HOME/.factory/config.json"
FACTORY_SET="$HOME/.factory/settings.json"
CODEX_CFG="$HOME/.codex/config.toml"
CLAUDE_LOCAL="$HOME/.local/bin/claude-local"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- model id + geometry: READ FROM THE PROFILE ----------------------------
# Never transcribed here. The profile is the one place a backend swap updates
# (test/model-profiles-qwen38-rails.test.ts already pins profile.model and the
# geometry against the live backend), and re-running this script then
# converges every harness on it. The engine tolerates any requested id, but
# the id is what the proxy logs and what session records show — clients must
# send the id served. Transcribing the geometry here is what left the sandbox
# rails assertions red on master through the whole 1-rail era.
PROFILE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config/model-profiles/${PROFILE_NAME}.json"
GEOMETRY="$(python3 - "$PROFILE_FILE" <<'PY'
import json, sys
try:
    p = json.load(open(sys.argv[1]))
    so = p["server_optimization"]
    print(p["model"], p["context_window"], so["kv_capacity"], so["parallel_rails"])
except Exception as e:
    sys.stderr.write("profile read failed: %s\n" % e)
    sys.exit(1)
PY
)" || die "cannot read the model id + geometry from $PROFILE_FILE — did a profile change break its shape?"
# CTX_SESSION: per-session cap, deliberately below the pool so a session at
# cap leaves the engine working room. CTX_POOL: the whole pool; only the
# guardrail-free direct path sees it. RAILS: admission follows the rail count.
read -r MODEL_ALIAS CTX_SESSION CTX_POOL RAILS <<< "$GEOMETRY"
[ -n "$MODEL_ALIAS" ] && [ -n "$CTX_SESSION" ] && [ -n "$CTX_POOL" ] && [ -n "$RAILS" ] \
  || die "$PROFILE_FILE returned an incomplete geometry row: $GEOMETRY"
# The alias is interpolated into TOML, JSON bodies and a shell wrapper below;
# anything but a plain model id would inject across those sinks. Repo-trusted
# input, so this is defense in depth — but it is one line.
[[ "$MODEL_ALIAS" =~ ^[A-Za-z0-9._/-]+$ ]] \
  || die "profile .model is not a plain model id: $MODEL_ALIAS"

backup() { # <file>
  [ -f "$1" ] || { note "absent, will create: $1"; return 0; }
  if [ "$DRY_RUN" = "1" ]; then note "DRY: backup $1"; return 0; fi
  mkdir -p "$BACKUP_DIR"
  cp -p "$1" "$BACKUP_DIR/$(echo "${1#"$HOME"/}" | tr '/' '_')"
  note "backed up $1"
}

# --- the proxy token, read from what opencode already uses -----------------
# Scoped to the 'qwen-proxy' provider ONLY. Taking "the first provider with an
# apiKey" would silently capture a CLOUD key the moment one is added ahead of
# it in that file, and this script then writes whatever it found into other
# config files and sends it as a header. Never widen this lookup.
PROXY_TOKEN=""
if [ -f "$OC_GLOBAL" ]; then
  PROXY_TOKEN=$(python3 - "$OC_GLOBAL" <<'PY' || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    k = ((d.get("provider", {}).get("qwen-proxy") or {}).get("options") or {}).get("apiKey")
    if k and k not in ("not-needed", "sk-no-auth") and not str(k).startswith("{env:"):
        print(k)
except Exception:
    pass
PY
)
fi
[ -n "$PROXY_TOKEN" ] || PROXY_TOKEN="not-needed"

cat <<BANNER
────────────────────────────────────────────────────────────────────
 UAP local agent config sync
   model    : $MODEL_ALIAS   (profile: $PROFILE_NAME)
   proxy    : $PROXY_URL     direct: $DIRECT_URL
   rails    : $RAILS  sharing ONE pool of $CTX_POOL
   per-sess : $CTX_SESSION   max output: $MAX_OUTPUT
   token    : $([ "$PROXY_TOKEN" = "not-needed" ] && echo "(none set; proxy has no PROXY_AUTH_TOKEN)" || echo "(read from $OC_GLOBAL)")
   mode     : $([ "$DRY_RUN" = "1" ] && echo "DRY RUN" || echo "APPLY")
   backups  : $BACKUP_DIR
────────────────────────────────────────────────────────────────────
 NOTE: agents in the global opencode config that point at a CLOUD
 provider are left alone. Only local/qwen ones are repointed.
────────────────────────────────────────────────────────────────────
BANNER

# ===========================================================================
say "1/6  Proxy env — use both rails"
[ -f "$PROXY_ENV" ] || die "missing $PROXY_ENV — the whole point of this script is the concurrency change; refusing to continue and report success"
backup "$PROXY_ENV"
set_kv() { # <key> <value>
  local k=$1 v=$2
  # Anchor matches a bare or `export`-prefixed assignment; without the export
  # form the script would append a second, contradictory line.
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${k}=" "$PROXY_ENV" 2>/dev/null; then
    if [ "$DRY_RUN" = "1" ]; then note "DRY: would set  ${k}=${v}"; return 0; fi
    # No eval: the path is a quoted argument, so a $HOME containing a quote
    # cannot break out into a second command.
    sed -i -E "s|^[[:space:]]*(export[[:space:]]+)?${k}=.*|${k}=${v}|" "$PROXY_ENV"
    note "set  ${k}=${v}"
  else
    if [ "$DRY_RUN" = "1" ]; then note "DRY: would add  ${k}=${v}"; return 0; fi
    # A file with no trailing newline would otherwise get the new key glued
    # onto the last line, destroying BOTH.
    if [ -s "$PROXY_ENV" ] && [ "$(tail -c1 "$PROXY_ENV" | wc -l)" -eq 0 ]; then
      printf '\n' >> "$PROXY_ENV"
    fi
    printf '%s=%s\n' "${k}" "${v}" >> "$PROXY_ENV"
    note "add  ${k}=${v}"
  fi
}
set_kv PROXY_CONCURRENCY_LIMIT "$RAILS"
set_kv UAP_MODEL_SLOTS "$RAILS"
# THIS is the setting that actually protects the shared pool.
# PROXY_CONCURRENCY_LIMIT gates in-flight REQUESTS; the admission limit gates
# distinct SESSIONS holding KV. It shipped at 4 (matching an older --parallel 4)
# and its own comment says to keep it equal to the slot count "so >slots
# sessions queue instead of evicting each other". Left at 4 against 2 rails,
# four hot sessions x 114688 = 458752 cells would be admitted against a 229376
# pool — the exact overcommit the per-session cap exists to prevent.
set_kv PROXY_SESSION_ADMISSION_LIMIT "$RAILS"
# Fallback ONLY. Do not mistake this for a cap: _maybe_recheck_context_window
# overwrites default_context_window (and every live monitor) with the /slots
# value on its next tick. It matters only if detection cannot reach the server.
set_kv PROXY_CONTEXT_WINDOW "$CTX_SESSION"

# ===========================================================================
say "2/6  opencode (global)"
backup "$OC_GLOBAL"
if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$(dirname "$OC_GLOBAL")"
  # Token travels in the ENVIRONMENT, never argv: /proc here is mounted without
  # hidepid, so /proc/<pid>/cmdline is world-readable while the call runs,
  # whereas /proc/<pid>/environ is owner-only. (It cannot go on stdin either —
  # `python3 -` reads its own program from there.)
  UAP_SYNC_TOKEN="$PROXY_TOKEN" python3 - "$OC_GLOBAL" "$PROXY_URL" "$DIRECT_URL" \
      "$MODEL_ALIAS" "$PROFILE_NAME" "$PROFILE_HEADER" "$CTX_SESSION" "$CTX_POOL" "$MAX_OUTPUT" <<'PY'
import json, os, sys
token = os.environ["UAP_SYNC_TOKEN"]
path, proxy, direct, alias, profile, hdr, ctx, pool, out = sys.argv[1:10]
ctx, pool, out = int(ctx), int(pool), int(out)

d = json.load(open(path)) if os.path.exists(path) else {}
d["$schema"] = "https://opencode.ai/config.json"

prov = d.setdefault("provider", {})
prov["qwen-proxy"] = {
    "npm": "@ai-sdk/anthropic",
    "name": "llama guardrail proxy (local)",
    "options": {
        "baseURL": f"{proxy}/v1",
        "apiKey": token,
        "chunkTimeout": 300000,
        # The profile header is what applies the per-session context cap.
        "headers": {"x-uap-proxy-token": token, hdr: profile},
    },
    "models": {
        "Qwen3.8-27B": {
            "name": "Qwen3.8 (UAP guardrail proxy)",
            "reasoning": True,     # server runs --reasoning-format auto
            "tool_call": True,
            "attachment": True,    # mmproj loaded: vision + video
            "limit": {"context": ctx, "output": out},
        }
    },
}
# Guardrail-free escape hatch, kept for probing only.
prov["llama.cpp-direct"] = {
    "npm": "@ai-sdk/openai-compatible",
    "name": "llama-server direct (NO guardrails)",
    "options": {"baseURL": f"{direct}/v1", "apiKey": "sk-no-auth"},
    "models": {
        alias: {
            "name": "Qwen3.8 (direct, no guardrails)",
            "limit": {"context": pool, "output": out},
        }
    },
}

LOCAL_MODEL = "qwen-proxy/Qwen3.8-27B"
# Old provider key; anything still referencing it would dangle.
stale_prefixes = ("llama.cpp/", "qwen-proxy/")
removed = prov.pop("llama.cpp", None)

def is_local_ref(v):
    return isinstance(v, str) and (
        v.startswith(stale_prefixes) or "qwen35-a3b-iq4xs" in v or "qwen38" in v.lower()
    )

d["model"] = LOCAL_MODEL

# Repoint ONLY agents already aimed at a local/qwen provider. An agent pinned
# to a cloud model is a deliberate choice and must survive this script.
kept, moved = [], []
for name, agent in (d.get("agent") or {}).items():
    if not isinstance(agent, dict) or "model" not in agent:
        continue
    if is_local_ref(agent["model"]):
        agent["model"] = LOCAL_MODEL
        moved.append(name)
    else:
        kept.append(f"{name}={agent['model']}")

# Non-agent references to the removed provider would dangle silently.
for key in ("small_model", "fast_model"):
    if is_local_ref(d.get(key)):
        d[key] = LOCAL_MODEL

json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
print(f"   wrote {path}")
print(f"   repointed agents : {', '.join(moved) or '(none)'}")
print(f"   left untouched   : {', '.join(kept) or '(none)'}")
PY
else
  note "DRY: would rewrite $OC_GLOBAL"
fi

# ===========================================================================
say "3/6  factory / droid"
for F in "$FACTORY_CFG" "$FACTORY_SET"; do
  [ -f "$F" ] || { note "absent: $F"; continue; }
  backup "$F"
  if [ "$DRY_RUN" != "1" ]; then
    UAP_SYNC_TOKEN="$PROXY_TOKEN" python3 - "$F" "$PROXY_URL" "$MODEL_ALIAS" <<'PY'
import json, os, sys
token = os.environ["UAP_SYNC_TOKEN"]
path, proxy, alias = sys.argv[1:4]
d = json.load(open(path))
changed = []
for key in ("custom_models", "customModels"):
    for m in d.get(key, []) or []:
        label = m.get("id") or m.get("model") or m.get("displayName") or "<unnamed>"
        # Retired local ids: the qwen35-era migration AND the id this very
        # script hardcoded as MODEL_ALIAS before 2026-10-07 — boxes this
        # script has already rewritten once carry qwen38-gsq-rco-27b, and
        # skipping them would leave the exact stale-entry class this run
        # exists to converge.
        if m.get("model") in ("qwen35-a3b-iq4xs", "qwen38-gsq-rco-27b"):
            m["model"] = alias
            for bk in ("base_url", "baseUrl"):
                if bk in m:
                    m[bk] = f"{proxy}/v1"
            for ak in ("api_key", "apiKey"):
                if ak in m:
                    m[ak] = token
            if m.get("noImageSupport"):
                m["noImageSupport"] = False   # mmproj is loaded
            for dk in ("model_display_name", "displayName"):
                if dk in m:
                    m[dk] = "Qwen3.8 local (UAP)"
            changed.append(str(label))
        # Split-brain: one 8317 entry pointed at a LAN IP, the rest localhost.
        for bk in ("base_url", "baseUrl"):
            v = m.get(bk)
            if isinstance(v, str) and "192.168.1.165:8317" in v:
                m[bk] = v.replace("192.168.1.165:8317", "localhost:8317")
                changed.append(f"{label} [8317 host]")
if not changed:
    print(f"   {path}: nothing to change (left byte-identical)")
else:
    json.dump(d, open(path, "w"), indent=2)
    open(path, "a").write("\n")
    print(f"   {path}: updated {len(changed)} entr{'y' if len(changed)==1 else 'ies'}")
    for c in changed:
        print(f"     - {c}")
PY
  else
    note "DRY: would patch $F"
  fi
done
note "NOTE: factory custom models carry no per-request header field, so they"
note "      cannot send $PROFILE_HEADER and will size to the FULL pool."
note "      Keep factory to one local session at a time."

# ===========================================================================
say "4/6  codex — local profile (cloud default untouched)"
if [ -f "$CODEX_CFG" ]; then
  backup "$CODEX_CFG"
  if [ "$DRY_RUN" = "1" ]; then
    note "DRY: would (re)write the uap-local provider + $PROFILE_NAME profile"
  else
    # Codex 0.120 dropped wire_api="chat" — a config that still carries it
    # fails to LOAD, breaking every codex invocation, profile or not. Codex
    # speaks the Responses API only; the guardrail proxy does not expose
    # /v1/responses (404) but the strata engine serves it natively. The local
    # profile therefore goes DIRECT ($DIRECT_URL, no guardrails) and carries
    # the per-session context cap client-side (model_context_window) — the
    # same cap the $PROFILE_HEADER applies on the proxy path. Follow-up: a
    # /v1/responses adapter on the proxy would restore the guardrailed route.
    # Blocks written by older runs are REPLACED wholesale: our sections are
    # removed (with their banner comments) and the canonical block appended,
    # so the file converges no matter which era wrote it — and the
    # hand-mangled partial states (profile without provider header) can no
    # longer duplicate a section. The user's own sections — default model,
    # [tui], other providers/profiles — are never touched.
    python3 - "$CODEX_CFG" "$MODEL_ALIAS" "$PROFILE_NAME" "$CTX_SESSION" "$MAX_OUTPUT" "$DIRECT_URL" <<'PY'
import sys
path, alias, profile, ctx, out, direct = sys.argv[1:7]
ours = {"model_providers.uap-local",
        "model_providers.uap-local.http_headers",
        "profiles." + profile}

def is_ours(line):
    s = line.strip()
    return s.startswith("[") and s.endswith("]") and s[1:-1].strip() in ours

lines = open(path).read().splitlines(keepends=True)
kept, i = [], 0
while i < len(lines):
    if is_ours(lines[i]):
        # Swallow our banner comment block directly above, if it is ours.
        j = len(kept)
        while j > 0 and kept[j - 1].lstrip().startswith("#"):
            j -= 1
        if any("UAP local stack" in kept[k] for k in range(j, len(kept))):
            del kept[j:]
        # Skip the section body: up to the next header line or EOF.
        i += 1
        while i < len(lines) and not (lines[i].startswith("[") and lines[i].rstrip().endswith("]")):
            i += 1
        continue
    kept.append(lines[i])
    i += 1
text = "".join(kept)
if text and not text.endswith("\n"):
    text += "\n"
text += """
# --- UAP local stack (regenerated by sync-local-agent-configs.sh) ----------
# Additive on purpose: your default model/provider is untouched. Use with:
#     codex --profile {profile}
# Direct strata route (codex speaks the Responses API only; the guardrail
# proxy has no /v1/responses yet). model_context_window carries the
# per-session cap the proxy header applies on the other harnesses.
[model_providers.uap-local]
name = "UAP local strata (direct, Responses API)"
base_url = "{direct}/v1"
wire_api = "responses"

[profiles.{profile}]
model = "{alias}"
model_provider = "uap-local"
model_context_window = {ctx}
model_max_output_tokens = {out}
""".format(profile=profile, alias=alias, direct=direct, ctx=ctx, out=out)
open(path, "w").write(text)
print("   codex: uap-local + profiles.%s -> %s (direct %s, responses)" % (profile, alias, direct))
PY
    note "wrote [model_providers.uap-local] + [profiles.$PROFILE_NAME] (responses, direct)"
  fi
else
  note "absent: $CODEX_CFG"
fi

# ===========================================================================
say "5/6  claude-local wrapper"
backup "$CLAUDE_LOCAL"
if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$(dirname "$CLAUDE_LOCAL")"
  # 0700 BEFORE the write, not chmod after: umask here is 0002, so `cat >`
  # followed by `chmod +x` yields 0775 — a group-writable executable on PATH,
  # in a group the ollama daemon account belongs to. install(1) creates the
  # file with the mode already set, leaving no window.
  install -m 700 /dev/null "$CLAUDE_LOCAL"
  cat > "$CLAUDE_LOCAL" <<EOF
#!/usr/bin/env bash
# Claude Code against the LOCAL Qwen3.8 stack (generated $(date +%F)).
# Plain \`claude\` still goes to the cloud; this wrapper is the local path.
#
# The token is READ AT RUNTIME from the opencode config rather than embedded,
# so this file holds no secret even if its mode is later loosened.
set -euo pipefail
_tok=\$(python3 - "\$HOME/.config/opencode/opencode.json" <<'PY' 2>/dev/null || true
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
export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_AUTH_TOKEN="\${ANTHROPIC_AUTH_TOKEN:-\$_tok}"
export ANTHROPIC_API_KEY="\${ANTHROPIC_API_KEY:-\$_tok}"
# Carries the model profile — this is what caps the session at $CTX_SESSION
# instead of the full $CTX_POOL shared pool.
export ANTHROPIC_CUSTOM_HEADERS="$PROFILE_HEADER: $PROFILE_NAME"
export ANTHROPIC_MODEL="\${ANTHROPIC_MODEL:-$MODEL_ALIAS}"
# Claude Code does not know local model ids; without this it assumes a 200k
# window and its auto-compact fires far too late for the per-session cap.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="\${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-$CTX_SESSION}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="\${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-$MAX_OUTPUT}"
unset _tok
exec claude "\$@"
EOF
  chmod 700 "$CLAUDE_LOCAL"
  note "wrote $CLAUDE_LOCAL (mode 700, no embedded secret)"
  case ":$PATH:" in
    *":$(dirname "$CLAUDE_LOCAL"):"*) : ;;
    *) note "NOTE: $(dirname "$CLAUDE_LOCAL") is not on PATH" ;;
  esac
else
  note "DRY: would write $CLAUDE_LOCAL"
fi

# ===========================================================================
say "6/6  restart proxy + verify"
# SKIP_SERVICE_OPS=1 keeps the sandbox test from restarting the real proxy:
# systemctl --user is per-USER, not per-$HOME, so a fake HOME does NOT isolate it.
if [ "${SKIP_SERVICE_OPS:-0}" = "1" ]; then
  note "SKIP_SERVICE_OPS=1 — not touching services"
elif [ "$DRY_RUN" != "1" ]; then
  systemctl --user restart uap-anthropic-proxy.service \
    || die "proxy restart failed — config is written but NOT in force"

  # /health returns HTTP 200 with {"status":"degraded"} when the inference
  # server is unreachable, so a status-code check alone passes over a broken
  # stack. Parse the body and require ok, and FAIL if it never arrives.
  healthy=0
  for _ in $(seq 1 30); do
    if body=$(curl -fsS -m 3 "$PROXY_URL/health" 2>/dev/null) \
       && printf '%s' "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
      healthy=1; break
    fi
    sleep 2
  done
  [ "$healthy" = "1" ] || die "proxy did not report status=ok within 60s (last body: ${body:-<none>})"
  note "proxy healthy (status=ok)"

  note "server rails:"
  curl -s -m 5 "$DIRECT_URL/slots" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(f'     slots={len(d)}  n_ctx={d[0].get(\"n_ctx\")} (SHARED pool, not per-rail)')
except Exception as e:
    print('     could not read /slots:', e)
" || true

  note "proxy concurrency:"
  P=$(systemctl --user show -p MainPID --value uap-anthropic-proxy.service)
  tr '\0' '\n' < "/proc/$P/environ" 2>/dev/null \
    | grep -E '^(PROXY_CONCURRENCY_LIMIT|UAP_MODEL_SLOTS|PROXY_CONTEXT_WINDOW)=' \
    | sed 's/^/     /' || note "     (could not read proxy env)"
fi

cat <<DONE

────────────────────────────────────────────────────────────────────
 Done.$([ "$DRY_RUN" = "1" ] && echo "  (DRY RUN — nothing changed)")
 Backups: $BACKUP_DIR
 Revert : cp <file> back from that directory, then
          systemctl --user restart uap-anthropic-proxy.service

 Verify the cap actually applies:
   bash scripts/verify-profile-header.sh     # asserts, exits non-zero on fail

 With PROXY_CONCURRENCY_LIMIT=$RAILS now live, flip
 config/model-profiles/qwen38.json -> concurrency.max_parallel_requests = $RAILS
 (the test pins it to the proxy env, so it will tell you.)
────────────────────────────────────────────────────────────────────
DONE

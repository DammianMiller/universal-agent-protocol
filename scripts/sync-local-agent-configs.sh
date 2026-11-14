#!/usr/bin/env bash
#
# sync-local-agent-configs.sh — point every coding agent at the live local stack.
#
#   Server : uap-strata-server.service on :8080 (strata serve layer, engine
#            0.1.59.1, unsloth UD-IQ4_XS v31 arm, ONE shared 131072 pool)
#   Proxy  : uap-anthropic-proxy.service on :4000 (Anthropic Messages API)
#   Profile: config/model-profiles/qwen38.json  (per-session window 114688)
#
# WHY A PER-SESSION CAP IS NEEDED
# --------------------------------
# anthropic_proxy.py detects n_ctx from /slots and that detection OVERWRITES
# both default_context_window AND every live session monitor (:3241-3245), so
# PROXY_CONTEXT_WINDOW is NOT a backstop — it is replaced within one recheck
# interval. The only thing that pins a session below the pool is a model
# profile's context_window, selected per request by the x-uap-model-profile
# header. Every client configured here therefore sends that header — or, for
# Droid (no header field), carries maxContextLimit client-side.
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
#   MODELS_ONLY=1 bash scripts/sync-local-agent-configs.sh
#          # converge ONLY the Droid customModels (user + project) onto the
#          # live alias; no proxy env requirement, no service ops, no other
#          # agent configs. This is the mode a session-start hook runs.
#   SKIP_SERVICE_OPS=1 ...                              # no systemctl/curl
#
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$HOME/.uap-backups/agent-config-sync-$STAMP"
DRY_RUN="${DRY_RUN:-0}"

# --- shared Droid (Factory) sync contract ---------------------------------
# Sourced, never executed: the lib is side-effect free and every value it
# defines is `:=`-defaulted, so a caller (this script, the sandbox test) may
# pre-set MODELS_ONLY / REPO_ROOT / PROJECT_FACTORY_SET / DROID_* and its own
# value wins. The installer and scripts/test-sync-sandbox.sh therefore assert
# against ONE contract instead of two transcriptions of it.
# shellcheck source=lib/droid-sync-contracts.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/droid-sync-contracts.sh"

# --- the single source of truth for every client ---------------------------
# Env-overridable so the sandbox test can point the MODELS_ONLY alias probe at
# a dead port and stay hermetic (no dependence on this machine's backend).
PROXY_URL="${PROXY_URL:-http://127.0.0.1:4000}"
DIRECT_URL="${DIRECT_URL:-http://127.0.0.1:8080}"
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

# PROXY_URL/DIRECT_URL are env-overridable (the sandbox points the MODELS_ONLY
# probe at a dead port), and they are interpolated into credential-bearing
# baseUrl fields and the generated claude-local wrapper — so a tunable value
# must still be a plain http(s) URL, same doctrine as the alias guard.
for _u in "$PROXY_URL" "$DIRECT_URL"; do
  [[ "$_u" =~ ^https?://[A-Za-z0-9.:/_-]+$ ]] \
    || die "PROXY_URL/DIRECT_URL must be a plain http(s) URL (got: $_u)"
done

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

# --- Droid (Factory) customModels convergence ------------------------------
# One lock across every target: the session hook, a manual run and a second
# Droid window all read-modify-write the same JSON; without the lock one
# writer's customModels silently loses the other's. Returns 1 when another
# sync holds the lock (callers skip, never wait — a session start must not
# hang behind a manual run).
droid_sync_lock() {
  mkdir -p "$(dirname "$DROID_SYNC_LOCK")" 2>/dev/null || true
  exec 9>>"$DROID_SYNC_LOCK" 2>/dev/null || return 1
  flock -n 9 2>/dev/null || return 1
  return 0
}

# sync_droid_models <file> <create-if-absent: 0|1> — converge ONE Droid config
# file onto the live alias. Route by the entry's existing shape (:8080 ->
# direct Responses, :4000 without /v1 -> Anthropic Messages root, anything
# else local -> proxy chat). Cloud entries are never repointed. Writes are
# atomic, idempotent (no change => byte-identical), and add the canonical
# proxy entry to a settings.json that has no local entry at all. A per-file
# failure prints WARN and returns 0 — one unreadable file must not abort the
# other targets. create=1 also means a fresh clone of this repo gains a
# machine-local (gitignored) .factory/settings.json pointing at the local
# stack — a dead entry on machines without it, accepted for an operator box.
sync_droid_models() { # <file> <create: 0|1>
  local f="$1" create="${2:-0}"
  if [ "$create" = "1" ]; then
    mkdir -p "$(dirname "$f")"
  fi
  [ -f "$f" ] || [ "$create" = "1" ] || { note "absent: $f"; return 0; }
  # backup happens INSIDE the python, only when something actually changed —
  # the session hook fires this constantly, and copies of unchanged files
  # are pure $HOME accumulation.
  UAP_SYNC_TOKEN="$PROXY_TOKEN" DRY_RUN="$DRY_RUN" \
    UAP_SYNC_BACKUP="$BACKUP_DIR" UAP_SYNC_REPO_ROOT="$REPO_ROOT" \
    python3 - "$f" "$PROXY_URL" "$DIRECT_URL" "$MODEL_ALIAS" \
              "$DROID_ANTHROPIC_BASE_MODEL" "$CTX_SESSION" "$CTX_POOL" \
              "$MAX_OUTPUT" "$create" <<'PY' || { note "WARN: $f could not be synced"; return 0; }
import json, os, re, shutil, sys, tempfile

path, proxy, direct, alias, base_model, ctx_s, ctx_p, out, create = sys.argv[1:10]
token = os.environ.get("UAP_SYNC_TOKEN", "not-needed")
dry = os.environ.get("DRY_RUN", "0") == "1"
ctx_s, ctx_p, out = int(ctx_s), int(ctx_p), int(out)

# Retired local ids: every arm this box has served since 2026-09. A client
# still pinned to one is the exact drift this sync exists to converge. They
# live in config/model-registry.json (retired_local_aliases) — the file that
# already keeps every arm — so the next arm swap is a profile + registry
# edit, never a tuple transcription here. Fail closed: a registry that
# cannot be read is a migration this script refuses to run blind.
reg = os.path.join(os.environ["UAP_SYNC_REPO_ROOT"], "config", "model-registry.json")
RETIRED = tuple(json.load(open(reg))["retired_local_aliases"])

def spell(camel):
    if camel:
        return ("baseUrl", "apiKey", "displayName", "maxContextLimit", "maxOutputTokens")
    return ("base_url", "api_key", "model_display_name", "max_context_limit", "max_output_tokens")

def setf(m, k, v, label, what, changed):
    if m.get(k) != v:
        m[k] = v
        changed.append(f"{label} [{what}]")

d = {}
exists = os.path.exists(path)
if exists:
    try:
        d = json.load(open(path))
    except Exception as e:
        print(f"   {path}: unreadable ({e}) — left untouched")
        sys.exit(1)

keys = [k for k in ("custom_models", "customModels") if k in d]
if not keys:
    if create == "1":
        keys = ["customModels"]     # a settings.json we create is camelCase
    elif exists:
        print(f"   {path}: no custom models key (left untouched)")
        sys.exit(0)
    else:
        print(f"   {path}: absent (left absent)")
        sys.exit(0)

changed = []
# The id this sync stamps on its canonical entry (add-if-missing below) — and
# the survivor preference when a duplicate group collapses (dedupe below).
canon = re.compile(r"^custom:Qwen[\d.]+-UAP-local-\d+$")
# A group member pinned by the session default outranks even the canonical
# entry: dropping it would leave sessionDefaultSettings.model dangling — the
# exact class of stale pin this sync exists to converge, not one to create.
_sd = d.get("sessionDefaultSettings")
default_model = _sd.get("model") if isinstance(_sd, dict) else None
for key in keys:
    camel = key == "customModels"
    BK, AK, DK, CK, OK = spell(camel)

    def _label(m):
        return str(m.get("id") or m.get("model") or m.get(DK) or "<unnamed>")

    models = d.setdefault(key, [])
    for m in models:
        if not isinstance(m, dict):
            continue
        label = str(m.get("id") or m.get("model") or m.get(DK) or "<unnamed>")
        base = m.get(BK)
        base = base if isinstance(base, str) else ""
        # Split-brain: one 8317 entry pointed at a LAN IP, the rest localhost.
        if "192.168.1.165:8317" in base:
            setf(m, BK, base.replace("192.168.1.165:8317", "localhost:8317"),
                 label, "8317 host", changed)
            base = m[BK]
        model = m.get("model")
        # Ours to converge: retired ids, the live alias itself, or a model-less
        # entry already pointed at THIS box's ports. Everything else — cloud
        # models, the :8317 cloud-router entries, other LAN servers (ports
        # alone don't identify this host) — is a deliberate user choice and
        # must survive this script untouched.
        if model is None:
            hlocal = any(t in base for t in ("://127.0.0.1:", "://localhost:", "://[::1]:")) \
                or base.startswith(("127.0.0.1:", "localhost:"))
            ours = hlocal and (":4000" in base or ":8080" in base)
        else:
            ours = model in RETIRED or model == alias
        if not ours:
            continue
        if model != alias:
            setf(m, "model", alias, label, "model", changed)
        if ":8080" in base:
            # Direct strata route (Responses API, no guardrails) — pool-sized.
            setf(m, BK, f"{direct}/v1", label, "-> direct", changed)
            setf(m, DK, "Qwen3.8 Flash-Next (direct, no guardrails)", label, "name", changed)
            setf(m, CK, ctx_p, label, f"ctx={ctx_p}", changed)
            setf(m, OK, out, label, "output", changed)
            # keeps its own api key
        elif ":4000" in base and not base.rstrip("/").endswith("/v1"):
            # Anthropic Messages shape: baseUrl is the proxy ROOT, no /v1.
            setf(m, BK, proxy, label, "-> proxy root", changed)
            setf(m, DK, "Qwen3.8 Flash-Next (UAP proxy)", label, "name", changed)
            setf(m, CK, ctx_s, label, f"ctx={ctx_s}", changed)
            setf(m, OK, out, label, "output", changed)
            if AK not in m:
                m[AK] = token
                changed.append(f"{label} [apiKey set]")
            if camel and not m.get("baseModelId"):
                # Without a Factory built-in here Droid warns the entry "does
                # not map to a built-in model" and drops tool-call inheritance.
                m["baseModelId"] = base_model
                changed.append(f"{label} [baseModelId={base_model}]")
        else:
            # Everything else converges on the proxy chat-completions route.
            setf(m, BK, f"{proxy}/v1", label, "-> proxy", changed)
            setf(m, DK, "Qwen3.8 Flash-Next (UAP local)", label, "name", changed)
            setf(m, CK, ctx_s, label, f"ctx={ctx_s}", changed)
            setf(m, OK, out, label, "output", changed)
            setf(m, AK, token, label, "apiKey", changed)
        if m.get("noImageSupport"):
            setf(m, "noImageSupport", False, label, "vision on", changed)  # mmproj is loaded
    # Dedupe the picker list. Droid copies every legacy config.json entry into
    # settings.json under a fresh id each time its copy era changes, so each
    # era leaves a full extra set of identical lines (the operator box carried
    # 54 entries for 28 models: every cloud line twice, the local model three
    # times). The picker renders displayName, so entries sharing (model,
    # baseUrl, displayName) ARE one line twice — collapse each group onto the
    # entry the session default pins when one is present (dropping it would
    # leave sessionDefaultSettings.model dangling), else the canonical entry
    # when one is present, else the LAST member — the newest copy era,
    # ASSUMING append order is era order (observed Droid behavior, not a
    # documented contract; on the operator box the later duplicate is the one
    # carrying the current router key, the earlier one a stale rotation).
    # Anything else — different model, route, or name — is a different line
    # and survives untouched.
    groups = {}
    for i, m in enumerate(models):
        if isinstance(m, dict):
            groups.setdefault((m.get("model"), m.get(BK), m.get(DK)), []).append(i)
    drop = set()
    for idxs in groups.values():
        if len(idxs) < 2:
            continue
        keep = next((i for i in idxs if isinstance(models[i].get("id"), str)
                     and models[i]["id"] == default_model), None)
        if keep is None:
            keep = next((i for i in idxs
                         if isinstance(models[i].get("id"), str) and canon.match(models[i]["id"])),
                        idxs[-1])
        for i in idxs:
            if i != keep:
                drop.add(i)
                changed.append(f"{_label(models[i])} [duplicate of {_label(models[keep])} dropped]")
    if drop:
        models[:] = [m for i, m in enumerate(models) if i not in drop]
    # add-if-missing (camelCase settings only): a Droid instance with no local
    # entry gains the canonical proxy entry, so every instance can call it.
    if camel and create == "1" and not any(
        isinstance(m, dict) and m.get("model") == alias for m in models
    ):
        nums = []
        for m in models:
            if isinstance(m, dict) and isinstance(m.get("id"), str):
                mt = re.search(r"(\d+)$", m["id"])
                if mt:
                    nums.append(int(mt.group(1)))
        idx = (max(nums) + 1) if nums else 0
        entry = {
            "model": alias, "id": f"custom:Qwen3.8-UAP-local-{idx}", "index": idx,
            "baseUrl": f"{proxy}/v1", "apiKey": token,
            "displayName": "Qwen3.8 Flash-Next (UAP local)",
            "noImageSupport": False, "provider": "generic-chat-completion-api",
            "maxOutputTokens": out, "maxContextLimit": ctx_s,
        }
        models.append(entry)
        changed.append(f"{entry['id']} [canonical entry added]")

# Dead favorites: a modelFavorites pin on a UAP-local custom id that no
# longer exists (qwen35-era ids whose entries the migration above converged
# or collapsed) renders a dead line in the favorites bar — the same drift
# this sync exists to converge. Repoint it at the surviving local entry: the
# canonical one when present, else the first proxy-chat entry with an id.
# Scoped to the historical local-entry id family (^custom:Qwen… carrying
# UAP/Proxy/local/direct): a favorite for a deleted CLOUD model is the user's
# choice to re-make, not this script's to redirect.
favs = d.get("modelFavorites")
if isinstance(favs, list):
    live = {m["id"] for key in keys for m in (d.get(key) or [])
            if isinstance(m, dict) and isinstance(m.get("id"), str)}
    local = [m for key in keys for m in (d.get(key) or [])
             if isinstance(m, dict) and m.get("model") == alias]

    def _base(m):
        return m.get("baseUrl") if isinstance(m.get("baseUrl"), str) else m.get("base_url")

    def _rank(m):
        mid = m.get("id")
        if not isinstance(mid, str):
            return (2, 2)
        return (0 if canon.match(mid) else 1, 0 if _base(m) == f"{proxy}/v1" else 1)

    fam = re.compile(r"^custom:Qwen.*?(UAP|Proxy|local|direct)", re.I)
    target = min(local, key=_rank) if local else None
    repointed = 0
    for i, f in enumerate(favs):
        if (isinstance(f, str) and isinstance(target, dict)
                and isinstance(target.get("id"), str) and f not in live and fam.match(f)):
            favs[i] = target["id"]
            changed.append(f"modelFavorites: {f} -> {target['id']} [dead favorite repointed]")
            repointed += 1
    if repointed and len(favs) != len(set(favs)):
        # two dead pins repointing at the same survivor must not leave the
        # favorites bar showing it twice
        favs[:] = list(dict.fromkeys(favs))

if not changed:
    print(f"   {path}: nothing to change (left byte-identical)")
    sys.exit(0)
if dry:
    print(f"   {path}: DRY RUN — {len(changed)} pending change(s)")
    for c in changed:
        print(f"     - {c}")
    sys.exit(0)
# Backup-on-change-only: the session hook fires this constantly, and a copy
# of an unchanged file is pure $HOME accumulation. Only this moment — the
# file existed AND something changed — owes a backup (same flattened name
# and mode preservation as the bash backup()).
if exists and os.environ.get("UAP_SYNC_BACKUP"):
    bdir = os.environ["UAP_SYNC_BACKUP"]
    os.makedirs(bdir, exist_ok=True)
    home = os.path.expanduser("~")
    rel = os.path.relpath(path, home) if path.startswith(home + os.sep) else path.lstrip("/")
    shutil.copy2(path, os.path.join(bdir, rel.replace(os.sep, "_")))
# Atomic write: a Droid session starting right now must never see a
# half-written settings file.
text = json.dumps(d, indent=2) + "\n"
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".uap-droid-")
try:
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
print(f"   {path}: {len(changed)} change(s)")
for c in changed:
    print(f"     - {c}")
PY
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
   mode     : $([ "$DRY_RUN" = "1" ] && echo "DRY RUN" || echo "APPLY")$([ "$MODELS_ONLY" = "1" ] && echo "  [MODELS ONLY]")
   backups  : $BACKUP_DIR
────────────────────────────────────────────────────────────────────
 NOTE: agents in the global opencode config that point at a CLOUD
 provider are left alone. Only local/qwen ones are repointed.
────────────────────────────────────────────────────────────────────
BANNER

# ===========================================================================
# MODELS_ONLY=1 — converge ONLY the Droid customModels, then leave.
# This is the mode a session-start hook runs: no proxy env requirement, no
# service operations, no other agent configs. The alias probe prefers what
# the backend is ACTUALLY serving (/props on the direct engine) over the
# profile, so a swap that has not reached the profile yet still converges the
# Droid list onto reality — the note names the source either way.
if [ "$MODELS_ONLY" = "1" ]; then
  if _props=$(curl -fsS -m 3 "$DIRECT_URL/props" 2>/dev/null); then
    _live=$(printf '%s' "$_props" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("model_alias", ""))
except Exception:
    pass' 2>/dev/null || true)
    if [ -n "$_live" ] && [[ "$_live" =~ ^[A-Za-z0-9._/-]+$ ]]; then
      if [ "$_live" != "$MODEL_ALIAS" ]; then
        note "live backend serves: $_live (profile pins $MODEL_ALIAS — PROFILE IS STALE, update it)"
        MODEL_ALIAS="$_live"
      else
        note "live backend confirms the profile alias: $MODEL_ALIAS"
      fi
    else
      note "/props returned no plain alias — keeping the profile alias"
    fi
  else
    note "backend probe unreachable ($DIRECT_URL/props) — keeping the profile alias"
  fi
  if droid_sync_lock; then
    sync_droid_models "$FACTORY_CFG" 0
    sync_droid_models "$FACTORY_SET" 1
    sync_droid_models "$PROJECT_FACTORY_SET" 1
  else
    note "another droid model sync holds $DROID_SYNC_LOCK — nothing done"
  fi
  note "MODELS_ONLY done — droid customModels converged; no service ops"
  exit 0
fi

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
# Three Droid targets: the legacy config.json, the user settings.json, and the
# repo-level .factory/settings.json (every Droid instance opened on this
# checkout reads that one too). All converge under the shared lock.
if droid_sync_lock; then
  sync_droid_models "$FACTORY_CFG" 0
  sync_droid_models "$FACTORY_SET" 1
  sync_droid_models "$PROJECT_FACTORY_SET" 1
else
  note "another droid model sync holds $DROID_SYNC_LOCK — section 3 skipped"
fi
note "NOTE: factory custom models carry no per-request header field, so they"
note "      cannot send $PROFILE_HEADER; maxContextLimit carries the per-"
note "      session cap client-side instead. Keep factory to one local"
note "      session at a time."

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

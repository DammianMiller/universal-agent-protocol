#!/usr/bin/env bash
#
# sync-local-agent-configs.sh — point every coding agent at the live local stack.
#
#   Server : uap-speedy-base-iq3s-server.service on :8080 (Speedy fork, engine
#            0.1.53, spec 8, MTP 8, min-p 0.70, ONE shared 131072-cell pool;
#            live since 2026-11-18)
#   Proxy  : uap-anthropic-proxy.service on :4000 (Anthropic Messages API)
#   Profile: config/model-profiles/qwen38.json  (per-session window 114688)
#   Family : the inkling2 family (Inkling 2 Mini — basalt 0.5.7 on the native
#            NVFP4-MX8 pack + squid5090 on the original HF checkpoint, one wire
#            id, family vision dynamic on the basalt arm / none on the squid
#            arm) is listed in every agent surface that can reach it:
#            opencode (own provider + own profile), droid pickers (family
#            listing), claude-local-inkling2. NOT codex: codex speaks the
#            Responses API only and neither arm serves /v1/responses (and the
#            proxy has no /v1/responses adapter yet).
#   Profile: config/model-profiles/inkling2.json (per-session window 262144)
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

# The gemma family's own serving geometry (the llama.cpp arm): the fit-probed
# window is 49152 and llama.cpp counts prompt AND output inside that window,
# so the Droid-side caps follow the BYOK rule — window minus output. The
# 16k session margin matches what CTX_SESSION keeps below the qwen pool.
GEMMA_CTX=32768
GEMMA_OUT=16384

# The inkling2 family's geometry — read from ITS OWN profile, the same
# one-contract rule as the qwen alias: config/model-profiles/inkling2.json
# is the one place the family's caps live (262144 per-session, deliberately
# under the smallest arm pool), and re-running this script converges every
# harness on it. INK_OUT is the proxy tool-turn cap (MAX_OUTPUT), matching
# the qwen listings' doctrine — the profile's max_tokens is the model's
# completion budget, the CLIENT-facing cap is the clamp the proxy enforces.
# Line-split parse, NOT word-split: the family's wire id carries a space
# ("Inkling 2 Mini"), which a `read -r A B <<<` would tear apart.
INK_PROFILE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config/model-profiles/inkling2.json"
INK_GEOMETRY="$(python3 - "$INK_PROFILE_FILE" <<'PY'
import json, sys
try:
    p = json.load(open(sys.argv[1]))
    print(p["model"])
    print(p["context_window"])
except Exception as e:
    sys.stderr.write("inkling2 profile read failed: %s\n" % e)
    sys.exit(1)
PY
)" || die "cannot read the inkling2 geometry from $INK_PROFILE_FILE — did a profile change break its shape?"
INK_MODEL="${INK_GEOMETRY%%$'\n'*}"
INK_CTX="${INK_GEOMETRY##*$'\n'}"
[ -n "$INK_MODEL" ] && [[ "$INK_CTX" =~ ^[0-9]+$ ]] \
  || die "$INK_PROFILE_FILE returned an incomplete geometry row: $INK_GEOMETRY"
INK_OUT="$MAX_OUTPUT"
# The pin and the profile model must agree: the Droid listing pins the wire
# id the profile routes to, and a mismatch would list a model the placement
# gate cannot resolve to the family.
[ "$INK_MODEL" = "$DROID_LOCAL_INKLING2_PIN" ] \
  || die "inkling2 profile model ($INK_MODEL) and DROID_LOCAL_INKLING2_PIN ($DROID_LOCAL_INKLING2_PIN) disagree — one place must own the wire id"

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
              "$DROID_ANTHROPIC_BASE_MODEL" "$DROID_CHAT_BASE_MODEL" \
              "$CTX_SESSION" "$CTX_POOL" "$MAX_OUTPUT" "$create" \
              "$DROID_LOCAL_27B_PIN" "$DROID_LOCAL_27B_DISPLAY" \
              "$DROID_LOCAL_GEMMA_PIN" "$DROID_LOCAL_GEMMA_DISPLAY" \
              "$DROID_GEMMA_BASE_MODEL" "$GEMMA_CTX" "$GEMMA_OUT" \
              "$DROID_LOCAL_INKLING2_PIN" "$DROID_LOCAL_INKLING2_DISPLAY" \
              "$DROID_INKLING2_BASE_MODEL" "$INK_CTX" "$INK_OUT" \
    <<'PY' || { note "WARN: $f could not be synced"; return 0; }
import json, os, re, shutil, sys, tempfile

path, proxy, direct, alias, base_model, chat_base, ctx_s, ctx_p, out, create, \
    pin27, name27, pin_g, name_g, gemma_base, ctx_g, out_g, \
    pin_i, name_i, ink_base, ctx_i, out_i = sys.argv[1:23]
token = os.environ.get("UAP_SYNC_TOKEN", "not-needed")
dry = os.environ.get("DRY_RUN", "0") == "1"
ctx_s, ctx_p, out = int(ctx_s), int(ctx_p), int(out)
ctx_g, out_g = int(ctx_g), int(out_g)
ctx_i, out_i = int(ctx_i), int(out_i)

# Retired local ids: every arm this box has served since 2026-09. A client
# still pinned to one is the exact drift this sync exists to converge. They
# live in config/model-registry.json (retired_local_aliases) — the file that
# already keeps every arm — so the next arm swap is a profile + registry
# edit, never a tuple transcription here. Fail closed: a registry that
# cannot be read is a migration this script refuses to run blind.
reg = os.path.join(os.environ["UAP_SYNC_REPO_ROOT"], "config", "model-registry.json")
_reg = json.load(open(reg))
RETIRED = tuple(_reg["retired_local_aliases"])
# Fleet wire ids: every id any family's advertises list carries, live arms
# AND router-compat names (gpt-5.1-codex etc.). A client entry pinned to one
# of these IS this box's served model when it points at this box's ports —
# the engine tolerates any requested id, so the pin never routes; the
# canonical picker line is the live alias. By NAME alone these ids are
# ambiguous (the compat names collide with real cloud ids), so the ours-rule
# below additionally requires a local base for them.
FLEET = {a for _fam in (_reg.get("models") or {}).values()
         for a in (_fam.get("advertises") or []) if isinstance(a, str)}
# The SECOND local family the pickers list alongside the live alias: the
# registry's qwen3.8-27b family. Derived from the registry, never
# transcribed — the pin must be an id that family advertises (fail-closed:
# a registry whose 27B family does not carry the pin simply stops ADDING
# the entry; the marker rule below still protects any existing one).
fam27 = (_reg.get("models") or {}).get("qwen3.8-27b") or {}
ADV27 = [a for a in (fam27.get("advertises") or []) if isinstance(a, str)]
# The THIRD local family the pickers list: the registry's gemma-4-31b
# family (the llama.cpp QAT+MTP arm). Same fail-closed rule — the pin must
# be an id that family advertises, else the listing is silently not added.
famg = (_reg.get("models") or {}).get("gemma-4-31b") or {}
ADVG = [a for a in (famg.get("advertises") or []) if isinstance(a, str)]
# The FOURTH local family: the registry's inkling2 family (Inkling 2 Mini —
# basalt 0.5.7 on the native NVFP4-MX8 pack and squid5090 on the original HF
# checkpoint, two arms sharing the :8080 slot and the wire id). Same
# fail-closed rule as the 27B/gemma pins.
fami = (_reg.get("models") or {}).get("inkling2") or {}
ADVI = [a for a in (fami.get("advertises") or []) if isinstance(a, str)]
# The marker id the sync stamps on its 27B family listing — the stake that
# distinguishes a DELIBERATE listing (never converged) from a stale pin
# (always converged), the same job the canon regex does for the alias entry.
marker27 = re.compile(r"^custom:Qwen[\d.]+-27B-UAP-local-\d+$")
# The gemma family's marker — same job as the 27B stake: family-shaped so an
# era change of the pin (a future config id) still exempts the DELIBERATE
# listing this sync wrote, while a plain-id gemma pin (no marker) is the
# same drift class as any stale fleet pin and converges onto the alias.
markerg = re.compile(r"^custom:gemma-4[\w.-]*-UAP-local-\d+$")
# The inkling2 family's marker — same stake job. The ENTRY id is
# hyphenated (custom:Inkling-2-Mini-UAP-local-N) even though the wire id
# carries a space ("Inkling 2 Mini"): ids ride Droid's settings references
# (sessionDefaultSettings, modelFavorites) as opaque strings, and the
# space-free form keeps every one of those references shell- and
# regex-friendly while the MODEL field stays the wire id both arms serve.
markeri = re.compile(r"^custom:Inkling-2-Mini-UAP-local-\d+$")

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
        # Deliberate 27B family listing: the marker id is this sync's own
        # stake, so it is exempt from convergence — repointing it would
        # erase the second family from the picker. Maintain, never migrate:
        # the entry keeps the current token, gains baseModelId when
        # absent, and its caps are re-maintained to the CURRENT geometry
        # (the add-if-missing below, or a dedupe pass, wrote the entry —
        # an era with a different window must not strand it stale).
        mid = m.get("id")
        if isinstance(mid, str) and marker27.match(mid):
            if m.get(AK) != token:
                setf(m, AK, token, label, "apiKey", changed)
            if camel and not m.get("baseModelId"):
                m["baseModelId"] = chat_base
                changed.append(f"{label} [baseModelId={chat_base}]")
            # Session size is GEOMETRY, not identity: the marker exempts
            # this entry from ALIAS convergence (repointing the model would
            # erase the family from the picker), but the caps it advertises
            # must track ctx_s/out exactly as the add-if-missing writes
            # them — a geometry change (2026-11-17: window 114688 -> 180224)
            # otherwise strands every pre-existing 27B listing at the old
            # window, which the qwen38-model-knowledge suite catches as
            # "27B listing is not session-sized".
            if m.get(CK) != ctx_s:
                setf(m, CK, ctx_s, label, "ctx", changed)
            if m.get(OK) != out:
                setf(m, OK, out, label, "out", changed)
            continue
        # Deliberate gemma family listing: same maintain-never-migrate rule
        # as the 27B marker. baseModelId is stamped only when the gemma base
        # variable is non-empty — the Factory catalog carries no Gemma
        # built-in, so the entry ships without one (Droid's unrecognized-model
        # path applies) and stamping a wrong-family built-in would pin
        # another family's reasoning conventions onto the arm.
        if isinstance(mid, str) and markerg.match(mid):
            if m.get(AK) != token:
                setf(m, AK, token, label, "apiKey", changed)
            if camel and gemma_base and not m.get("baseModelId"):
                m["baseModelId"] = gemma_base
                changed.append(f"{label} [baseModelId={gemma_base}]")
            continue
        # Deliberate inkling2 family listing: same maintain-never-migrate
        # rule. Caps ARE maintained here to the inkling2 profile geometry
        # (the 27B rule, not the gemma one — the family's arms can swap
        # under the listing and a stale ctx belief would strand it at an
        # old posture). baseModelId only when the inkling2 base variable is
        # non-empty — the Factory catalog carries no Inkling built-in.
        if isinstance(mid, str) and markeri.match(mid):
            if m.get(AK) != token:
                setf(m, AK, token, label, "apiKey", changed)
            if m.get(CK) != ctx_i:
                setf(m, CK, ctx_i, label, "ctx", changed)
            if m.get(OK) != out_i:
                setf(m, OK, out_i, label, "out", changed)
            if camel and ink_base and not m.get("baseModelId"):
                m["baseModelId"] = ink_base
                changed.append(f"{label} [baseModelId={ink_base}]")
            continue
        # A self-managed entry (apiKeyHelper set) manages its OWN routing:
        # the operator's fleet-arm-ensure class, where the helper switches
        # the Inference Panel arm, ensures the proxy, and registers the
        # client BEFORE the request, and prints the token the entry rides
        # (its stdout contract REPLACES whatever apiKey the entry carries).
        # The sync cannot know what a helper does, so converging the model
        # under one would pair a qwen id with an inkling arm-ensure (or vice
        # versa) — corrupted, silently. Such entries are deliberate by
        # construction: never converged, never re-capped, never deduped
        # away, key untouched (the helper owns it).
        if m.get("apiKeyHelper"):
            continue
        base = m.get(BK)
        base = base if isinstance(base, str) else ""
        # Split-brain: one 8317 entry pointed at a LAN IP, the rest localhost.
        if "192.168.1.165:8317" in base:
            setf(m, BK, base.replace("192.168.1.165:8317", "localhost:8317"),
                 label, "8317 host", changed)
            base = m[BK]
        model = m.get("model")
        # Ours to converge: retired ids, the live alias itself, a fleet wire id
        # pointed at THIS box, or a model-less entry already pointed at THIS
        # box's ports. Everything else — cloud models, the :8317 cloud-router
        # entries, other LAN servers (ports alone don't identify this host) —
        # is a deliberate user choice and must survive this script untouched.
        hlocal = any(t in base for t in ("://127.0.0.1:", "://localhost:", "://[::1]:")) \
            or base.startswith(("127.0.0.1:", "localhost:"))
        if model is None:
            ours = hlocal and (":4000" in base or ":8080" in base)
        else:
            ours = model in RETIRED or model == alias
            if not ours and model in FLEET:
                # Fleet ids are ambiguous BY NAME (the compat list also
                # carries cloud ids like gpt-5.1-codex), so a fleet pin is
                # only ours when the entry points at this box's ports — a
                # cloud-router entry with the same model id survives.
                ours = hlocal and (":4000" in base or ":8080" in base)
        # CAPS ARE GEOMETRY (2026-11-19): an entry deliberately pinned to a
        # switchable arm's id (the 2026-11-17 gsq-rco-era default left one in
        # the Droid pickers advertising the retired-era 180224 window against
        # the live 114688 posture) keeps ITS CHOSEN id — the id is the
        # operator's arm choice — but the caps it advertises must track the
        # CURRENT geometry exactly as the marker rule maintains the 27B and
        # gemma listings: a stale ctx belief is a correctness bug on a capped
        # box no matter which arm the line names, and factory/droid custom
        # models cannot send the profile header, so their maxContextLimit IS
        # the cap. Route-sized like the ours-branch: direct :8080 pool-sized,
        # proxy session-sized. Only caps and output are touched; the model,
        # route and key stay the operator's choice.
        if (not ours and isinstance(model, str) and hlocal
                and (":4000" in base or ":8080" in base)
                and model.startswith(("qwen3.8", "Qwen3.8"))):
            want_ctx = ctx_p if ":8080" in base else ctx_s
            if m.get(CK) != want_ctx:
                setf(m, CK, want_ctx, label, f"ctx={want_ctx} (geometry)", changed)
            if m.get(OK) != out:
                setf(m, OK, out, label, "out (geometry)", changed)
            continue
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
            if camel and not m.get("baseModelId"):
                # Same Qwen3.8 family on the Responses route: inherit the
                # built-in's prompts/tools/reasoning instead of tripping the
                # "does not map to a built-in model" warning.
                m["baseModelId"] = chat_base
                changed.append(f"{label} [baseModelId={chat_base}]")
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
            if camel and not m.get("baseModelId"):
                # The chat route serves the same Qwen3.8 family: without a
                # Factory built-in here Droid warns the entry "does not map
                # to a built-in model" and drops prompt/tool inheritance.
                m["baseModelId"] = chat_base
                changed.append(f"{label} [baseModelId={chat_base}]")
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
                         if isinstance(models[i].get("id"), str) and canon.match(models[i]["id"])), None)
        if keep is None:
            # A 27B-marker member is this sync's stake in the group — the
            # same preference the canon id gets in alias groups.
            keep = next((i for i in idxs
                         if isinstance(models[i].get("id"), str) and marker27.match(models[i]["id"])),
                        None)
        if keep is None:
            # A gemma-marker member gets the same stake preference.
            keep = next((i for i in idxs
                         if isinstance(models[i].get("id"), str) and markerg.match(models[i]["id"])),
                        None)
        if keep is None:
            # An inkling2-marker member gets the same stake preference.
            keep = next((i for i in idxs
                         if isinstance(models[i].get("id"), str) and markeri.match(models[i]["id"])),
                        None)
        if keep is None:
            keep = idxs[-1]
        for i in idxs:
            if i != keep:
                # A self-managed entry is never dropped as a duplicate: its
                # helper pairs with ITS model/route, and the group's "keep"
                # member would not carry that pairing.
                if models[i].get("apiKeyHelper"):
                    continue
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
            "baseModelId": chat_base,
            "maxOutputTokens": out, "maxContextLimit": ctx_s,
        }
        models.append(entry)
        changed.append(f"{entry['id']} [canonical entry added]")

    # The 27B family listing rides alongside the canonical entry: a Droid
    # instance with no entry pinned to the 27B family gains it, so both
    # local families appear in every picker. Same chat route, same token,
    # same session-sized cap (conservative under every 27B arm's window);
    # baseModelId inherits the Qwen3.8-family built-in like the alias entry.
    # Fail-closed on the registry: the pin must be an id the qwen3.8-27b
    # family advertises, else the listing is silently not added (the
    # registry, not this script, owns the family's ids).
    if (camel and create == "1" and pin27 in ADV27 and not any(
        isinstance(m, dict) and m.get("model") == pin27 for m in models
    )):
        nums27 = []
        for m in models:
            if isinstance(m, dict) and isinstance(m.get("id"), str):
                mt = re.search(r"(\d+)$", m["id"])
                if mt:
                    nums27.append(int(mt.group(1)))
        i27 = (max(nums27) + 1) if nums27 else 0
        entry27 = {
            "model": pin27, "id": f"custom:{pin27}-UAP-local-{i27}", "index": i27,
            "baseUrl": f"{proxy}/v1", "apiKey": token,
            "displayName": name27,
            "noImageSupport": False, "provider": "generic-chat-completion-api",
            "baseModelId": chat_base,
            "maxOutputTokens": out, "maxContextLimit": ctx_s,
        }
        models.append(entry27)
        changed.append(f"{entry27['id']} [27B family entry added]")

    # The gemma family listing rides alongside both: the registry's
    # gemma-4-31b family (the llama.cpp QAT+MTP arm). Same chat route and
    # token as the other families, but the arm's OWN geometry: noImageSupport
    # is true (the arm has no mmproj — the qwen listings carry vision), the
    # caps are the arm's 48k window minus output (llama.cpp counts both in
    # ctx), and baseModelId is written only when a Gemma built-in exists in
    # the Factory catalog (it does not — an honest omission beats a
    # wrong-family mapping). Fail-closed on the registry like the 27B pin.
    if (camel and create == "1" and pin_g in ADVG and not any(
        isinstance(m, dict) and m.get("model") == pin_g for m in models
    )):
        nums_g = []
        for m in models:
            if isinstance(m, dict) and isinstance(m.get("id"), str):
                mt = re.search(r"(\d+)$", m["id"])
                if mt:
                    nums_g.append(int(mt.group(1)))
        ig = (max(nums_g) + 1) if nums_g else 0
        entry_g = {
            "model": pin_g, "id": f"custom:{pin_g}-UAP-local-{ig}", "index": ig,
            "baseUrl": f"{proxy}/v1", "apiKey": token,
            "displayName": name_g,
            "noImageSupport": True, "provider": "generic-chat-completion-api",
            "maxOutputTokens": out_g, "maxContextLimit": ctx_g,
        }
        if gemma_base:
            entry_g["baseModelId"] = gemma_base
        models.append(entry_g)
        changed.append(f"{entry_g['id']} [gemma family entry added]")

    # The inkling2 family listing rides alongside the other three: the
    # registry's inkling2 family (Inkling 2 Mini — basalt on the native
    # NVFP4-MX8 pack, squid5090 on the original HF checkpoint, one wire id,
    # the placement gate serves whichever arm is resident). Same chat route
    # and token as the other families, caps from the inkling2 PROFILE (the
    # one place the family's geometry lives), noImageSupport False — the
    # family's vision is dynamic on the basalt arm and the proxy's placement
    # gate parks image traffic on the text-only arm and auto-switches, so
    # the picker line advertising vision is honest (a transient park, then
    # the retry forwards). baseModelId only when an Inkling Factory
    # built-in exists (it does not). Fail-closed on the registry like the
    # 27B/gemma pins. The entry ID is hyphenated even though the wire id
    # carries a space — see the markeri comment above.
    if (camel and create == "1" and pin_i in ADVI and not any(
        isinstance(m, dict) and m.get("model") == pin_i for m in models
    )):
        nums_i = []
        for m in models:
            if isinstance(m, dict) and isinstance(m.get("id"), str):
                mt = re.search(r"(\d+)$", m["id"])
                if mt:
                    nums_i.append(int(mt.group(1)))
        ii = (max(nums_i) + 1) if nums_i else 0
        entry_i = {
            "model": pin_i, "id": f"custom:Inkling-2-Mini-UAP-local-{ii}", "index": ii,
            "baseUrl": f"{proxy}/v1", "apiKey": token,
            "displayName": name_i,
            "noImageSupport": False, "provider": "generic-chat-completion-api",
            "maxOutputTokens": out_i, "maxContextLimit": ctx_i,
        }
        if ink_base:
            entry_i["baseModelId"] = ink_base
        models.append(entry_i)
        changed.append(f"{entry_i['id']} [inkling2 family entry added]")

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
  # The alias probe prefers what the backend is ACTUALLY serving over the
  # profile, so a swap that has not reached the profile yet still converges
  # the Droid list onto reality — the note names the source either way.
  # /props first (the llama.cpp/strata arms answer it), then the
  # OpenAI-shaped /v1/models — the vLLM-class fleet arms (hyperqwen, live
  # since 2026-11-19) serve /v1 only and 404 /props, which is how a live
  # vLLM arm used to read as "backend probe unreachable". A single-id model
  # list names the served alias unambiguously; a multi-id list is a router
  # box, and the profile alias stands (ambiguity is not convergence).
  _live=""
  if _props=$(curl -fsS -m 3 "$DIRECT_URL/props" 2>/dev/null); then
    _live=$(printf '%s' "$_props" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("model_alias", ""))
except Exception:
    pass' 2>/dev/null || true)
    if [ -n "$_live" ]; then
      note "live /props alias: $_live"
    fi
  fi
  if [ -z "$_live" ] && _mlist=$(curl -fsS -m 3 "$DIRECT_URL/v1/models" 2>/dev/null); then
    _live=$(printf '%s' "$_mlist" | python3 -c '
import json, sys
try:
    ids = [m.get("id") for m in json.load(sys.stdin).get("data", [])
           if isinstance(m, dict) and isinstance(m.get("id"), str) and m.get("id")]
    if len(ids) == 1:
        print(ids[0])
except Exception:
    pass' 2>/dev/null || true)
    if [ -n "$_live" ]; then
      note "live /v1/models alias: $_live (single served id)"
    fi
  fi
  if [ -n "$_live" ] && [[ "$_live" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    if [ "$_live" != "$MODEL_ALIAS" ]; then
      note "live backend serves: $_live (profile pins $MODEL_ALIAS — PROFILE IS STALE, update it)"
      MODEL_ALIAS="$_live"
    else
      note "live backend confirms the profile alias: $MODEL_ALIAS"
    fi
  else
    note "backend probe unreachable ($DIRECT_URL/props and /v1/models) — keeping the profile alias"
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
# PROXY_CONCURRENCY_LIMIT above gates in-flight REQUESTS; the admission
# limit gates distinct SESSIONS holding KV. OPERATOR DECISION 2026-11-18:
# admission installs 4 on EVERY arm (the 2026-11-17 queue-depth override,
# made the durable default instead of a post-sync re-apply). The trade is
# accepted overcommit of the session-cap arithmetic (4 hot sessions x the
# 114688 window demand 458752 cells of the 131072 pool on this arm): the
# admission machinery handles contention — idle sessions prune at the 90s
# TTL and a waiter force-admits at 300s by evicting the LRU admission — so
# this is a queue-depth preference, not a pool budget. The runtime default
# in tools/agents/scripts/anthropic_proxy.py matches (fallback "4").
set_kv PROXY_SESSION_ADMISSION_LIMIT "4"
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
      "$MODEL_ALIAS" "$PROFILE_NAME" "$PROFILE_HEADER" "$CTX_SESSION" "$CTX_POOL" "$MAX_OUTPUT" \
      "$DROID_LOCAL_INKLING2_PIN" "inkling2" "$INK_CTX" "$INK_OUT" <<'PY'
import json, os, sys
token = os.environ["UAP_SYNC_TOKEN"]
path, proxy, direct, alias, profile, hdr, ctx, pool, out = sys.argv[1:10]
pin_i, profile_i, ctx_i, out_i = sys.argv[10:14]
ctx, pool, out = int(ctx), int(pool), int(out)
ctx_i, out_i = int(ctx_i), int(out_i)

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
        # The local menu lists BOTH families. The Flash-Next key is the
        # DEFAULT (d["model"] + the repoint target below); the 27B key is
        # the registry family id — deliberately NOT the old default string
        # "Qwen3.8-27B", which every pre-listing pin was created under to
        # mean "the local default". Using the family key lets this sync
        # repoint those legacy pins to the Flash-Next default (the semantic
        # they were set under) exactly once, while any NEW pin to the 27B
        # family survives as a deliberate choice.
        "Qwen3.8-Flash-Next": {
            "name": "Qwen3.8 Flash-Next (UAP guardrail proxy)",
            "reasoning": True,     # server runs --reasoning-format auto
            "tool_call": True,
            "attachment": True,    # mmproj loaded: vision + video
            "limit": {"context": ctx, "output": out},
        },
        "qwen3.8-27b": {
            "name": "Qwen3.8 27B (UAP guardrail proxy)",
            "reasoning": True,
            "tool_call": True,
            "attachment": True,
            "limit": {"context": ctx, "output": out},
        },
    },
}
# Guardrail-free escape hatch, kept for probing only.
prov["llama.cpp-direct"] = {
    "npm": "@ai-sdk/openai-compatible",
    "name": "local backend direct (NO guardrails)",
    "options": {"baseURL": f"{direct}/v1", "apiKey": "sk-no-auth"},
    "models": {
        alias: {
            "name": "Qwen3.8 (direct, no guardrails)",
            "limit": {"context": pool, "output": out},
        }
    },
}

# The inkling2 family (Inkling 2 Mini — basalt NVFP4-MX8 + squid5090, one
# wire id, the placement gate serves whichever arm is resident and
# auto-switches for image traffic). A SEPARATE PROVIDER, not a fourth models
# key under qwen-proxy: the profile header is what applies the per-session
# cap, and it is provider-level here — a listing under qwen-proxy would
# send the qwen38 profile, whose model field the proxy APPLIES AS THE WIRE
# MODEL (the profile rewrite), silently rerouting every Inkling request to
# the qwen alias. Same proxy, same token, its own profile.
prov["inkling2-proxy"] = {
    "npm": "@ai-sdk/anthropic",
    "name": "inkling2 guardrail proxy (local)",
    "options": {
        "baseURL": f"{proxy}/v1",
        "apiKey": token,
        "chunkTimeout": 300000,
        "headers": {"x-uap-proxy-token": token, hdr: profile_i},
    },
    "models": {
        pin_i: {
            "name": "Inkling 2 Mini (UAP guardrail proxy)",
            # Thinking-first: reasoning streams via reasoning_content before
            # content; native tool calls verified on both arms.
            "reasoning": True,
            "tool_call": True,
            # Family vision is dynamic on the basalt arm; the placement
            # gate parks image traffic on the text-only squid arm with a
            # switch, so the attachment capability is honest.
            "attachment": True,
            "limit": {"context": ctx_i, "output": out_i},
        },
    },
}

LOCAL_MODEL = "qwen-proxy/Qwen3.8-Flash-Next"
# Current local listings — deliberate pins that must survive now that the
# local menu carries two families (the legacy "qwen-proxy/Qwen3.8-27B"
# default-era pins are NOT in this set on purpose: see the models map above).
# The inkling2 listing is its own provider's only model, so a pin on it is
# always a deliberate choice.
VALID_LOCAL = {LOCAL_MODEL, "qwen-proxy/qwen3.8-27b", f"inkling2-proxy/{pin_i}"}
# Old provider key; anything still referencing it would dangle.
stale_prefixes = ("llama.cpp/", "qwen-proxy/")
removed = prov.pop("llama.cpp", None)

def is_local_ref(v):
    # A pin on a CURRENT listing is a deliberate choice, never stale drift.
    if not isinstance(v, str) or v in VALID_LOCAL:
        return False
    return v.startswith(stale_prefixes) or "qwen35-a3b-iq4xs" in v or "qwen38" in v.lower()

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
    note "NOTE: the inkling2 family is NOT codex-reachable — codex speaks the"
    note "      Responses API only; the inkling2 arms (basalt + squid5090)"
    note "      serve OpenAI chat/completions and the proxy has no"
    note "      /v1/responses adapter. Add the adapter to route codex too."
  fi
else
  note "absent: $CODEX_CFG"
fi

# ===========================================================================
say "5/6  claude-local wrappers"
# Two wrappers: the qwen default (claude-local) and the inkling2 family
# (claude-local-inkling2). Both ride the guardrail proxy with their OWN
# model profile — the profile header is what caps the session, and the
# profile's model field is what the proxy puts on the wire, so each family
# needs its own profile pin. The inkling2 wrapper keeps the vision caveat
# honest in-band: image requests park for a transient arm switch when the
# text-only squid arm is resident, then the retry forwards.
write_claude_local() { # <path> <model> <profile> <ctx> <out> <family-line>
  local w="$1" model="$2" prof="$3" ctx="$4" out="$5" family="$6"
  backup "$w"
  if [ "$DRY_RUN" = "1" ]; then
    note "DRY: would write $w"
    return 0
  fi
  mkdir -p "$(dirname "$w")"
  # 0700 BEFORE the write, not chmod after: umask here is 0002, so `cat >`
  # followed by `chmod +x` yields 0775 — a group-writable executable on PATH,
  # in a group the ollama daemon account belongs to. install(1) creates the
  # file with the mode already set, leaving no window.
  install -m 700 /dev/null "$w"
  cat > "$w" <<EOF
#!/usr/bin/env bash
# Claude Code against the LOCAL $family stack (generated $(date +%F)).
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
# Carries the model profile — this is what caps the session at $ctx
# and pins the wire model the proxy routes to.
export ANTHROPIC_CUSTOM_HEADERS="$PROFILE_HEADER: $prof"
export ANTHROPIC_MODEL="\${ANTHROPIC_MODEL:-$model}"
# Claude Code does not know local model ids; without this it assumes a 200k
# window and its auto-compact fires far too late for the per-session cap.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="\${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-$ctx}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="\${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-$out}"
unset _tok
exec claude "\$@"
EOF
  chmod 700 "$w"
  note "wrote $w (mode 700, no embedded secret)"
  case ":$PATH:" in
    *":$(dirname "$w"):"*) : ;;
    *) note "NOTE: $(dirname "$w") is not on PATH" ;;
  esac
}

write_claude_local "$CLAUDE_LOCAL" "$MODEL_ALIAS" "$PROFILE_NAME" "$CTX_SESSION" "$MAX_OUTPUT" "Qwen3.8"
write_claude_local "$CLAUDE_LOCAL-inkling2" "$DROID_LOCAL_INKLING2_PIN" "inkling2" "$INK_CTX" "$INK_OUT" "Inkling 2 Mini"

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

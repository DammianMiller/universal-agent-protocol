#!/usr/bin/env bash
#
# droid-sync-contracts.sh — SHARED CONTRACT for Droid (Factory) model sync.
# -----------------------------------------------------------------------------
# Every Droid/Factory instance — the user-level ~/.factory/config.json and
# ~/.factory/settings.json AND the repo-level .factory/settings.json — must
# auto-converge its customModels onto the LIVE local qwen3.8 backend instead
# of drifting onto retired ids and stale hosts.
#
# This file is the single place the installer and the sandbox test agree on:
# the variable names and their defaults. It is SOURCED (never executed) by
# scripts/sync-local-agent-configs.sh and by scripts/test-sync-sandbox.sh, so
# the installer and the assertions read ONE contract instead of two
# transcriptions of it — a number or path transcribed in both places is
# exactly the failure class that left the sandbox suite red through the
# 1-rail era. The FUNCTION bodies live in sync-local-agent-configs.sh
# (sync_droid_models / droid_sync_lock); the sandbox asserts them textually
# against that file, so this contract stays free of dead stub code.
#
# CONTRACT RULES (this file is frozen once accepted):
#   * Sourcing is SIDE-EFFECT FREE: no I/O, no mkdir, no network, no writes.
#     Every value is a `: "${VAR:=default}"` assignment, so a caller may
#     pre-set any of them (the sandbox does, to point at a throwaway $HOME)
#     and the caller's value always wins.
#   * Nothing here depends on bash features beyond 4.2.
#
# shellcheck shell=bash
#

# Double-source guard: the installer and the sandbox may both source this.
if [ -n "${_UAP_DROID_SYNC_CONTRACTS_LOADED:-}" ]; then
  return 0 2>/dev/null || true
fi
_UAP_DROID_SYNC_CONTRACTS_LOADED=1

# ===========================================================================
# SHARED VARIABLES — all overridable from the environment.
# ===========================================================================

# MODELS_ONLY — when "1", the sync touches ONLY the customModels/custom_models
# arrays of the Droid config files. No service operations (systemctl/curl),
# no proxy env requirement, no other agent configs. This is the mode the
# auto-convergence session hook runs in: it must be safe to fire on every
# session start, on any machine state.
#   "0" (default) = full sync      "1" = customModels only
: "${MODELS_ONLY:=0}"

# REPO_ROOT — absolute path of the checkout the sync is running against.
# Derived from this file's own location (scripts/lib/ -> repo root), never
# from $PWD, so a hook fired from a subdirectory still resolves the repo
# .factory/settings.json correctly. A caller (the installer, the sandbox)
# may pre-set it to redirect the whole sync at a throwaway tree.
: "${REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# PROJECT_FACTORY_SET — the repo-level Droid settings file whose customModels
# must converge alongside the user-level ones. camelCase spelling
# ("customModels"), same shape as ~/.factory/settings.json.
: "${PROJECT_FACTORY_SET:=$REPO_ROOT/.factory/settings.json}"

# DROID_ANTHROPIC_BASE_MODEL — the Factory BUILT-IN catalog id written into
# `baseModelId` of anthropic-provider entries. A custom Anthropic-provider
# model inherits that built-in's prompt/tool-call behavior; without it Droid
# warns the entry "does not map to a built-in model". claude-sonnet-4-6 is the
# choice because it accepts reasoning-effort "off" (the proxy sends none) and
# speaks the Anthropic Messages class the :4000 proxy serves. This is NOT a
# local model id — it must never carry a qwen id.
: "${DROID_ANTHROPIC_BASE_MODEL:=claude-sonnet-4-6}"

# DROID_CHAT_BASE_MODEL — the Factory BUILT-IN catalog id written into
# `baseModelId` of the OpenAI-shaped local entries (the proxy chat /v1 route
# and the direct Responses :8080 route). qwen3.8-max is the choice because the
# served stack IS the Qwen3.8 family (Flash-Next 125B arms and its Edge0-145B
# latent-MoE derivative): the entry inherits the built-in's Qwen3.8-class
# prompts, tool-call conventions, reasoning levels, and Script-mode
# eligibility instead of tripping the "does not map to a built-in model"
# warning. Same family, same catalog — this is a BUILT-IN id, never a local
# wire id: it must never be the served alias, a retired arm, or anything the
# registry's advertises lists carry. (The prefix-era guard "never a qwen id"
# predates the Factory catalog gaining Qwen3.8 built-ins; the exact local-id
# check lives in the sandbox suite.)
: "${DROID_CHAT_BASE_MODEL:=qwen3.8-max}"

# DROID_LOCAL_27B_PIN / DROID_LOCAL_27B_DISPLAY — the SECOND local family the
# Droid pickers list alongside the live Flash-Next alias: the registry's
# qwen3.8-27b family (the llama.cpp / yskn / vLLM 27B arms — same :4000/:8080
# endpoints, the engine serves whichever arm is switched live, so the entry
# is a FAMILY LISTING, not a route switch; when placement turns on, the pin
# is registry-matchable). The pin must be an id that family advertises —
# checked against config/model-registry.json at sync time, fail-closed to
# skip-adding. A camelCase entry carrying the 27B marker id
# (custom:Qwen…-27B-UAP-local-N) is a DELIBERATE listing: the convergence
# loop never repoints or renames it, it only stamps baseModelId when absent.
: "${DROID_LOCAL_27B_PIN:=Qwen3.8-27B}"
: "${DROID_LOCAL_27B_DISPLAY:=Qwen3.8 27B (UAP local)}"

# DROID_LOCAL_GEMMA_PIN / DROID_LOCAL_GEMMA_DISPLAY — the THIRD local family
# the Droid pickers list alongside the live Flash-Next alias and the 27B
# family: the registry's gemma-4-31b family (the llama.cpp QAT+MTP arm —
# same :4000/:8080 endpoints, the engine serves whichever arm is switched
# live, so the entry is a FAMILY LISTING, not a route switch; when placement
# turns on, the pin is registry-matchable). Same rules as the 27B pin: the
# pin must be an id that family advertises — checked against
# config/model-registry.json at sync time, fail-closed to skip-adding. A
# camelCase entry carrying the gemma marker id
# (custom:gemma-4…-UAP-local-N) is a DELIBERATE listing: the convergence
# loop never repoints or renames it.
: "${DROID_LOCAL_GEMMA_PIN:=gemma-4-31b-qat-ud-q4_k-xl-mtp}"
: "${DROID_LOCAL_GEMMA_DISPLAY:=Gemma 4 31B (UAP local)}"

# DROID_GEMMA_BASE_MODEL — the Factory BUILT-IN written into baseModelId of
# the gemma listing, "" by default: the Factory catalog carries NO Gemma
# built-in (its Google section is Gemini-only), so the honest entry ships
# WITHOUT baseModelId — Droid's unrecognized-model path applies (per-model
# defaultReasoningEffort) instead of a wrong-family mapping; stamping a
# Gemini built-in here would pin Gemini reasoning conventions onto a Gemma
# arm. Empty means the entry and its marker-maintain branch both omit the
# field; set it only if the catalog ever gains a Gemma family.
: "${DROID_GEMMA_BASE_MODEL:=}"

# DROID_SYNC_LOCK — lock file serialising concurrent Droid config writes
# (session-start hook + manual installer run + a second Droid window).
# Without it two writers read-modify-write the same JSON and one set of
# customModels silently loses the other's update. Defaults under
# $XDG_RUNTIME_DIR so it is per-user and per-boot; /tmp is the fallback for
# environments without XDG_RUNTIME_DIR (containers, CI sandboxes).
# $XDG_RUNTIME_DIR is per-user (0700 tmpfs); the /tmp fallback is
# world-writable, so key it per-uid there or any local user could hold the
# lock forever and silently disable convergence.
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  : "${DROID_SYNC_LOCK:=$XDG_RUNTIME_DIR/uap-droid-sync.lock}"
else
  : "${DROID_SYNC_LOCK:=/tmp/uap-droid-sync-$UID.lock}"
fi

# ===========================================================================
# FUNCTION CONTRACT (bodies live in sync-local-agent-configs.sh)
# ===========================================================================
# droid_sync_lock — acquire fd 9 on $DROID_SYNC_LOCK with `flock -n`.
#   returns 0 = lock held for this script; 1 = another sync holds it.
#
# sync_droid_models <FILE> <CREATE> — converge ONE Droid config file.
#   FILE   : a Droid settings.json (camelCase customModels) or legacy
#            config.json (snake_case custom_models).
#   CREATE : "1" = create the file (with the canonical entry) when absent —
#            only settings targets use this; the legacy file is patched
#            in place or left alone. "0" = patch only when present.
#   Reads from the caller's scope: MODEL_ALIAS, PROXY_URL, DIRECT_URL,
#   CTX_SESSION, CTX_POOL, MAX_OUTPUT, DROID_ANTHROPIC_BASE_MODEL,
#   DROID_CHAT_BASE_MODEL, DROID_LOCAL_27B_PIN, DROID_LOCAL_27B_DISPLAY,
#   DROID_LOCAL_GEMMA_PIN, DROID_LOCAL_GEMMA_DISPLAY, DROID_GEMMA_BASE_MODEL,
#   GEMMA_CTX, GEMMA_OUT, PROXY_TOKEN (via UAP_SYNC_TOKEN env), DRY_RUN.
#   Migration rules (idempotent; no change => file left byte-identical):
#     * entries whose model is a RETIRED local id — already the live alias,
#       a FLEET wire id (any registry advertises entry) pointed at this
#       box's :4000/:8080, or model-less but pointed at :4000/:8080 —
#       converge onto MODEL_ALIAS (fleet ids are gated on a local base:
#       the compat names collide with real cloud ids, so a cloud-router
#       entry carrying one survives untouched);
#     * a camelCase entry whose id carries the 27B marker
#       (custom:Qwen…-27B-UAP-local-N) or the gemma marker
#       (custom:gemma-4…-UAP-local-N) is a DELIBERATE family listing:
#       it is skipped by the convergence loop (only apiKey is refreshed,
#       and baseModelId is stamped when absent AND that family's base-model
#       variable is non-empty) and is preferred over non-marker members
#       in its dedupe group;
#     * route by existing shape: baseUrl with :8080 -> direct strata route
#       (pool-sized); :4000 WITHOUT /v1 -> Anthropic Messages root (proxy
#       root + baseModelId=DROID_ANTHROPIC_BASE_MODEL + apiKey only if
#       absent, session-sized); anything else local -> proxy chat route
#       ($PROXY_URL/v1 + token); every camelCase local route also gains
#       baseModelId (anthropic shape -> DROID_ANTHROPIC_BASE_MODEL, OpenAI
#       shapes -> DROID_CHAT_BASE_MODEL) when absent, so Droid inherits the
#       built-in's prompts/tools/reasoning instead of warning the entry
#       "does not map to a built-in model";
#     * cloud models (anything else, including the :8317 router entries) are
#       deliberate user choices and are never repointed;
#     * a settings.json with NO local entry after migration gains the
#       canonical proxy entry (add-if-missing), gains the 27B family
#       entry (model=DROID_LOCAL_27B_PIN on the proxy chat route, marker
#       id, baseModelId) when the pin is an id the registry's qwen3.8-27b
#       family advertises, and gains the gemma family entry
#       (model=DROID_LOCAL_GEMMA_PIN on the proxy chat route, marker id,
#       noImageSupport=true — the arm has no mmproj — caps GEMMA_CTX/
#       GEMMA_OUT, baseModelId only when DROID_GEMMA_BASE_MODEL is set)
#       when the pin is an id the registry's gemma-4-31b family
#       advertises — the three-family listing: Flash-Next live alias +
#       the 27B family + the gemma family, side by side in every picker;
#     * the 192.168.1.165:8317 split-brain host is fixed everywhere;
#     * writes are atomic (tmp file in the same directory + os.replace),
#       under the flock, with backups taken by the caller's backup().
#   returns 0 always (a per-file failure is a printed WARN, not an abort).

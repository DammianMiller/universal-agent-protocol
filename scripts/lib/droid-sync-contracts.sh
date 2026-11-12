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

# DROID_SYNC_LOCK — lock file serialising concurrent Droid config writes
# (session-start hook + manual installer run + a second Droid window).
# Without it two writers read-modify-write the same JSON and one set of
# customModels silently loses the other's update. Defaults under
# $XDG_RUNTIME_DIR so it is per-user and per-boot; /tmp is the fallback for
# environments without XDG_RUNTIME_DIR (containers, CI sandboxes).
: "${DROID_SYNC_LOCK:=${XDG_RUNTIME_DIR:-/tmp}/uap-droid-sync.lock}"

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
#   PROXY_TOKEN (via UAP_SYNC_TOKEN env), DRY_RUN.
#   Migration rules (idempotent; no change => file left byte-identical):
#     * entries whose model is a RETIRED local id — or already the live
#       alias, or model-less but pointed at :4000/:8080 — converge onto
#       MODEL_ALIAS;
#     * route by existing shape: baseUrl with :8080 -> direct strata route
#       (pool-sized); :4000 WITHOUT /v1 -> Anthropic Messages root (proxy
#       root + baseModelId + apiKey only if absent, session-sized); anything
#       else local -> proxy chat route ($PROXY_URL/v1 + token);
#     * cloud models (anything else, including the :8317 router entries) are
#       deliberate user choices and are never repointed;
#     * a settings.json with NO local entry after migration gains the
#       canonical proxy entry (add-if-missing);
#     * the 192.168.1.165:8317 split-brain host is fixed everywhere;
#     * writes are atomic (tmp file in the same directory + os.replace),
#       under the flock, with backups taken by the caller's backup().
#   returns 0 always (a per-file failure is a printed WARN, not an abort).

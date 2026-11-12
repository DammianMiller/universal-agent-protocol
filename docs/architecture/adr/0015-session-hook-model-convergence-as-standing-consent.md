# ADR 0015: Session-start model convergence as standing operator consent

- Status: Accepted
- Date: 2026-11-12
- Spec: `docs/guides/LOCAL_MODELS.md` (Droid section), `scripts/sync-local-agent-configs.sh` (`MODELS_ONLY`)
- Supersedes: none — extends ADR 0007's standing-consent class (displacement
  allowlist, idle unload) to the case of a hook that rewrites agent config
  files outside the repo on every session.

## Context

Droid instances (user-level plus per-project `.factory/settings.json`) pin
local model entries by hand, so every arm swap leaves them naming a retired
alias until someone notices. `sync-local-agent-configs.sh` converges them, but
it is an operator-run script — nothing keeps the lists fresh "at any given
time." The natural fix is a `SessionStart` hook running the script's
`MODELS_ONLY=1` mode, which means an unattended process rewriting files
OUTSIDE the repo (`~/.factory/...` and the repo's own gitignored
`.factory/settings.json`) on every Droid session start, indefinitely. That is
a standing consent in exactly ADR 0007's sense, and this repo ADRs that class
of decision.

## Decision

1. **The consent subject is the MODELS_ONLY surface, not any particular
   file.** The hook may only run `MODELS_ONLY=1` — Droid `customModels` lists
   and nothing else: no proxy-env writes, no codex/opencode/claude-local
   plumbing, no service operations, no token discovery (the scoped token
   travels only within entries already on the machine).

2. **Run-shape guards bound the consent** (the ADR 0007 pattern):
   - one non-blocking `flock` across every target — a second Droid window
     starting mid-sync skips, never waits (a session start must not hang
     behind a manual run);
   - atomic `mkstemp` + `os.replace` writes — a concurrently starting Droid
     never sees a torn settings file;
   - byte-identical idempotence — a converged file is never rewritten;
   - **backup-on-change-only** — a no-op fire adds nothing to `~/.uap-backups`;
     only files the run actually changed are copied (mode-preserved), one
     directory per changing run;
   - per-file WARN-not-abort — one unreadable file never aborts the other
     targets.

3. **The alias comes from the live backend** (`/props` on the direct engine,
   3s-bounded probe, profile fallback), so the hook follows reality even
   mid-swap. A profile that lags still surfaces as a red rails drift test —
   never as silently-stale client pins.

4. **Retired ids are single-sourced** in `config/model-registry.json`
   (`retired_local_aliases`); the hook migrates from that list, so an arm swap
   is a profile + registry edit. No file outside the repo carries new
   knowledge.

5. **Revocation** is unwiring the `SessionStart` entry; every changed file is
   restorable from that run's backup directory, and convergence itself pauses
   whenever the lock is held.

## Consequences

- Every Droid session on this machine starts with its custom-model list
  pointed at whatever arm is actually serving — "auto-populated from what is
  running in UAP" becomes standing behavior, not an operator trigger.
- The hook writes the repo's own gitignored `.factory/settings.json` when a
  fresh clone gains one (a dead entry on machines without the local stack —
  accepted for an operator box).
- Like ADR 0007's allowlists, this consent must be reviewed as standing
  access: widening MODELS_ONLY beyond Droid `customModels`, or dropping any
  guard in §2, is a new consent decision — not a patch to this one.

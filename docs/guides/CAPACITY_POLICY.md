# Capacity Policy as Code

Uplift 0.5 of the [System-1 uplift plan](../plans/system1-uplift-2026-09-18.md):
every UAP-managed service declares its resource budget, its headroom
requirement, and its restart discipline; `uap doctor` probes each service and
reports GREEN/RED/DARK health against the declaration.

This generalizes the 2026-09-18 llama.cpp OOM fix: four SIGABRT crashes
happened because a KV-cache budget was resolved against a GPU that also runs
a desktop, and nothing declared that relationship. The fix held, but the
*discipline* (declare budget + headroom + restart baseline, watch for
violations) lived in a commit message. Now it is data.

## Policy file

Resolution order: `--policy <path>`, then `config/capacity-policy.json` in
the project, then `~/.config/uap/capacity-policy.json`.

```json
{
  "version": 1,
  "services": [
    {
      "name": "gsq-rco-server",
      "systemd": { "unit": "uap-gsq-rco-server.service", "scope": "user" },
      "budget": { "vramMiB": 5120, "note": "--vbr-vram 5120M (OOM fix 2026-09-18)" },
      "headroom": { "gpuMinFreeMiB": 600 },
      "restartBudget": { "knownRestarts": 0, "allowedNew": 0 }
    }
  ]
}
```

- **budget** — what the service is configured to stay inside (free-text
  `note` records the provenance: which incident, which flag).
  - `budget.vramMiB` declares the service's *own* allocator limit (e.g.
    `--vbr-vram 5120M`), which the server enforces internally. The doctor
    does **not** compare it against the process's total GPU footprint —
    the host-side invariant it owns is `headroom.gpuMinFreeMiB`.
  - `budget.rssMiB` **is** enforced: compared against the unit's
    `MemoryCurrent`. Declaring it when systemd cannot report memory
    (cgroup accounting off) is RED — a declared budget that cannot be
    verified is not healthy.
- **headroom.gpuMinFreeMiB** — free VRAM the *host* must keep; below it the
  service is in OOM territory even while running.
- **restartBudget** — `knownRestarts` is the accepted historical baseline
  (e.g. crashes already fixed); `allowedNew` new crashes beyond that turn the
  service RED. Zero is the right default after a fix lands.

## Health semantics

| Health | Meaning |
| --- | --- |
| GREEN | Unit active and serving, restarts within budget, headroom verified. |
| RED | A budget is violated or unverifiable: new crashes since the baseline, GPU free below declared headroom, RSS over budget, headroom/RSS declared but not probeable. Also RED while `activating` (e.g. `SubState=auto-restart`) — a `Restart=always` crash loop is not yet serving, so it never reads GREEN, with or without a declared `restartBudget`. |
| DARK | Unit failed/inactive/unresolvable — the service is *absent*, not degraded. |
| UNKNOWN | systemd itself unavailable (container, macOS) — never a fabricated GREEN. |

## Running it

```bash
uap doctor             # report, advisory (exit 0)
uap doctor --json      # machine-readable
uap doctor --strict    # exit 1 on RED/DARK — for CI and monitor loops
```

Reference implementation: `config/capacity-policy.json` in this repo is the
**live policy of the gsq build host**, committed deliberately — the uplift
requires the gsq-rco llama.cpp server and its watchdog monitor to be the
reference implementations, and keeping the real file in-repo means `uap
doctor` run from this checkout reports that host truthfully. Consumers
elsewhere should ship their own `config/capacity-policy.json` (project) or
`~/.config/uap/capacity-policy.json` (operator); the resolution order above
makes the committed file the fallback only inside this repo.

`uap doctor --strict` is the natural health source for the monitor service
to consult before restarting anything, and for CI to refuse a deploy into a
degraded host.

## Decisions

- **Restarts are budgeted against a baseline, not a rate.** `NRestarts` is a
  monotonic counter; "crashes per day" windows go stale. The policy records
  how many restarts are *explained* (pre-fix) and alerts on new ones.
  Known hole: `systemctl restart` / `reset-failed` resets `NRestarts` to 0,
  so bouncing a crash-looping unit produces a false GREEN until the next
  crash. Re-baseline `knownRestarts` in the same commit as any legitimate
  restart (deploy, config change) — a `uap doctor --rebaseline` verb is
  planned as a follow-up; until it lands the edit is manual and deliberate.
- **UNKNOWN instead of fail-open GREEN.** A doctor that cannot probe must say
  so; a green report from a blind probe is the failure mode this tool exists
  to prevent.
- **One GPU probe per run** shared across services — nvidia-smi is not cheap.
- **Probes fail soft on a 5s timeout.** A wedged driver or D-Bus makes the
  doctor report UNKNOWN/RED-unverified instead of hanging the monitor loop
  that called it.
- **`uap doctor` vs `uap config doctor`:** the latter diagnoses *settings*
  health; this diagnoses *running services* against declared capacity.

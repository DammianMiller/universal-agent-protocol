# delivery-enforcement

**Category**: safety
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: uap, delivery, deliver, convergence, enforcement

## Rule

Substantive coding work SHOULD go through the `uap deliver` convergence loop,
which drives a model to verified completion against the project's real gates
(build, type-check, tests) rather than ad-hoc hand edits.

The enforcer fires on `Edit` / `Write` / `MultiEdit` operations targeting
source-code files, and on `Bash` commands that write source through the shell
(a redirect, heredoc, `tee` or `sed -i`), launch a GUI browser, or destroy the
gate's own state (see below). It is satisfied when any of the following holds:

- the edit runs inside a deliver-driven context (`UAP_DELIVER_ACTIVE=1`),
- an explicit operator override is set (`UAP_DELIVER_BYPASS=1`),
- the target is not source code, or is a docs/config/script/policy/test path.

Otherwise the policy applies.

## Why

`uap deliver` exists and is auto-routable (CLI + MCP `deliver` tool), and it
classifies task complexity to enable the right convergence aids automatically.
But nothing previously *encouraged or required* coding agents to use it — the
capability was available, not enforced. This policy closes that gap: it makes
the expectation explicit and, when a team opts in, enforces it.

## Enforcement

Python enforcer `delivery_enforcement.py`.

**Default mode is BLOCK** — a direct source edit outside a deliver context is
blocked (exit 2) until the work is routed through `uap deliver` (or
`UAP_DELIVER_ACTIVE`/`UAP_DELIVER_BYPASS` is set).

**Advisory mode is opt-out** via `UAP_ENFORCE_DELIVERY=advisory` — it then
always allows the edit and logs a one-line nudge toward `uap deliver` instead
of blocking.

Exempt by construction: non-source files; `docs/`, `scripts/`, `policies/`,
`src/policies/`, test files (deliver protects those itself); and tooling
dot-dirs (`.claude/`, `.uap/`, `.worktrees/`, …).

**One carve-out from that dot-dir exemption: the gate's own state.** Destroying
`.uap/pending-deliver.jsonl`, `.uap/deliver.lock` or `.uap/deliver.heartbeat` —
by `rm`, `unlink`, `shred`, `truncate`, `mv`, `find -delete`, `git clean`, a
truncating `>` redirect, or removing `.uap/` itself — is blocked. The pending log
is the replay queue for `uap deliver --pending`, so deleting it discards recorded
work rather than completing it; the lock and heartbeat are how an in-flight run
is found, followed, and reclaimed when wedged, so deleting them starts a second
concurrent run on the same tree. Observed live 7x on 2026-07-31
(octopus_invaders_v3), interleaved with `kill -9` of the running deliver.

Unlike an edit, this block is **not** relaxed by `UAP_ENFORCE_DELIVERY=advisory`:
advisory trades verification for speed on a change, but destroying recorded state
has no verified-later equivalent. deliver's own housekeeping is unaffected — it
rewrites the pending log in-process, and its subprocesses carry
`UAP_DELIVER_ACTIVE=1`.

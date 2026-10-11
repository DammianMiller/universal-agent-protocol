# The Sandbox — kernel-level isolation for skip-permissions sessions

> **🏭 Where this fits:** Isolation station. The hook-based worktree/workdir guards
> (`PreToolUse`) are the everyday boundary, but a harness launched with
> `--dangerously-skip-permissions` ignores hook denials entirely. The sandbox is the
> compensating control that *can't* be skipped — because it's enforced by the Linux
> kernel, not by a hook the agent's flags can wave away.
> **What it delivers:** an agent that can read your whole machine but can only *write*
> inside the job's workdir (plus a few caches), so a mis-fired `rm -rf` or an errant Write
> to `~/.ssh` fails at the kernel with `EROFS`.

## What it is

`uap sandbox -- <command>` runs `<command>` inside a **bubblewrap (`bwrap`)** mount
namespace: the whole filesystem is bind-mounted **read-only**, with a small set of
**writable holes** punched through. This binds Write/Edit tools, `Bash`, and every
subprocess they spawn equally — nothing that runs inside can write outside the holes.

It is *not* a container, *not* a VM, and *not* env-variable restriction. It is a Linux
namespace, so it has near-zero startup cost and shares the host network (deliberately — the
agent still needs to reach the local proxy at `127.0.0.1:4000`).

```bash
# Typical wiring: sandbox wraps the whole harness invocation
uap sandbox -- env … claude --dangerously-skip-permissions …
```

## What's writable (and nothing else)

`src/cli/sandbox.ts:86-105` binds these as read-write; everything else is read-only:

- the **resolved workdir** (the job's project directory)
- `/tmp`, a fresh tmpfs `/var/tmp`, and `/run`
- `~/.claude`, `~/.cache`, `~/.npm` (if present) — so the harness and package tooling work
- anything listed in **`UAP_SANDBOX_ALLOW`** (colon-separated extra prefixes)

Plus `--unshare-pid --die-with-parent --new-session` so the sandboxed process tree can't
outlive or escape its parent.

**Guardrail:** it refuses to sandbox an over-broad workdir — `$HOME`, `/`, and `/home` are
rejected (`sandbox.ts:81-83`), because a writable hole that big would defeat the point.

**Requires bwrap:** if `bwrap` isn't installed, `uap sandbox` fails with exit 127 rather
than silently running your command unsandboxed. There is no unsafe fallback.

## Why hooks aren't enough

The `workdir-scope` and `worktree_required` `PreToolUse` enforcers return an exit-2 deny to
block an out-of-bounds edit — but a harness run with `--dangerously-skip-permissions`
**does not consult PreToolUse hooks at all**, so those denials never fire. The sandbox is
the answer: the kernel doesn't care what flags the harness was launched with. This is the
one boundary that survives skip-permissions (see also `documentation/permissions.md`, which
maps every enforcement plane and where each one holds or fails).

## Browser MCP tool stripping (why it's here)

A subtlety worth knowing: when a session runs under `uap sandbox`, the Chrome extension
socket that the `mcp__claude-in-chrome__*` browser tools rely on is **not** bound into the
namespace — so those tools would connect to nothing and the model loops on a dead end.

The sandbox handles this without changing the tool list itself. `sandboxCustomHeaders()`
(`sandbox.ts:30-39`) appends a marker header `X-Uap-Sandbox: 1` to
`ANTHROPIC_CUSTOM_HEADERS`, which the harness forwards on every request. The **proxy** reads
it and calls `_strip_sandbox_unreachable_tools` (`anthropic_proxy.py:4393`), removing any
tool whose name starts with a prefix in `PROXY_SANDBOX_UNREACHABLE_PREFIXES` (default
`mcp__claude-in-chrome__`). The model never sees the unreachable browser tools and falls
back to `WebFetch` / local reads instead. (This is the "strip unreachable browser MCP tools
from sandboxed sessions" behavior.)

## Per-session grants (P4: recorded authority)

`UAP_SANDBOX_ALLOW` widens the boundary but nobody consented on the record. Bridge Phase 4
adds a **consent ledger**: every extra writable hole is a *grant* — scoped to a session,
bounded by a TTL, stated with a reason, recorded with who consented, and audit-logged on
use.

```bash
# consent to one more hole for this session (reason is REQUIRED)
uap sandbox grant /var/cache/ccache --session my-session --reason "shared compiler cache" --ttl 3600
uap sandbox grants [--session <id>] [--json]      # inspect
uap sandbox revoke sbg-557c11d5                  # take it back
# then run with the session that owns the grants
uap sandbox --session my-session -- claude --dangerously-skip-permissions
```

Rules worth knowing:

- The `--` separator before the command is REQUIRED: without it the sandbox's own flags
  (`--session`, `--net`, `--ttl`, `--reason`, `--json`) are parsed as sandbox options, not
  passed through. The grant verbs are intercepted only when there is no `--` —
  `uap sandbox -- revoke …` runs a binary named `revoke`, not the ledger verb.
- **Consent comes from the operator, never from inside a sandbox.** `grant`/`revoke` are
  refused when `UAP_SANDBOX_ACTIVE=1` (that flag is set by the sandbox on the untrusted
  side); listing stays available. And the ledger + audit files are mounted READ-ONLY into
  every sandbox namespace — a bind-mounted file cannot be unlinked, replaced, or written
  inside it — so a sandboxed agent can neither plant grant rows nor forge audit lines.
- A grant is refused without `--session`, `--reason`, or a grantable target (an existing
  absolute path; `/`, `/home`, and `$HOME` itself are refused — an over-broad grant IS a
  sandbox escape, checked after symlink resolution, and re-resolved at plan time to close
  the swap race).
- `--ttl` fails CLOSED on garbage: a non-numeric or negative value is refused (not
  silently upgraded to the 8h default); `--ttl 0` means "expires immediately" (floored to
  1s). Grants default to **8h** and hard-cap at **7d**; an identical open grant is renewed,
  not duplicated; expired grants are invisible to the sandbox. Every persist is
  re-verified against a concurrent writer before success is reported.
- The ledger lives at the MAIN checkout's `.uap/sandbox-grants.json` (one ledger per
  checkout, shared by every surface — the ADR 0010 anchor). Every sandbox run appends to
  `.uap/sandbox-audit.jsonl`: which grants were used, which network mode engaged, and any
  legacy `UAP_SANDBOX_ALLOW` entries labeled `unrecordedAllow` — still honored, now named.
  Audit lines carry a monotonic `seq` and the file is BOUNDED: past 12,000 lines it
  compacts to the newest 10,000 with an `audit-compaction` marker recording the drop.
- **Tamper evidence (the ADR 0011 trust anchor).** Every recorded grant/renew/revoke also
  writes a 0600 anchor OUTSIDE the checkout
  (`$XDG_STATE_HOME/uap/sandbox-anchors/<hash-of-root>.json`) recording the hash of the
  sanitized ledger. On load, the ledger is re-hashed and compared: if something with the
  checkout's write reach changed it outside a recorded consent operation, `uap sandbox
  grants` stamps the listing INTEGRITY MISMATCH (rows shown but unverified), new grants
  are REFUSED, and a sandbox session opens ZERO grant-derived holes — the kernel boundary
  itself is unaffected. Revoking still works (removing authority is the safe direction)
  and re-anchors the remaining rows as the new baseline, naming the prior mismatch
  loudly. `UAP_SANDBOX_ANCHOR_DIR` pins the anchor dir (tests, odd layouts).
- `UAP_SANDBOX_GRANTS_OFF=1` resolves zero grants; `UAP_SANDBOX_GRANTS` pins the ledger
  file (tests, odd layouts).

See [ADR 0011](../architecture/adr/0011-sandbox-grants-and-network-egress-boundary.md) for
the design and its trust model (the ledger is shared-write state, so it is sanitized at
ingest AND on load — a planted row must not become a kernel-writable hole).

## Network egress boundary (P4: `--net off`)

The P0 sandbox shares the host network (the agent must reach the proxy). For runs that
should have **no network at all** — untrusted code, evals, data-only work — `--net off`
adds `--unshare-net` with nothing brought up: no TCP, no DNS, not even loopback, at the
kernel. Any `connect()` fails; a harness that needs the model fails loudly with connection
refused, which is the boundary working.

```bash
uap sandbox --net off -- npm test          # kernel-enforced zero egress
UAP_SANDBOX_NET=off uap sandbox -- ...     # default the mode for every run
```

Every run's actual mode (`shared` / `off`) is audit-logged. There is deliberately **no
`--net proxy`** (netns cut with a single hole to the proxy): rootless Linux cannot express
it — AF_UNIX sockets are network-namespace-scoped, bwrap closes every inherited fd, and
the userspace network stacks have no outbound allowlist. A boundary that only works with
the right helper installed would be a suggestion, not enforcement. The full analysis and
the rejected alternatives live in
[ADR 0011](../architecture/adr/0011-sandbox-grants-and-network-egress-boundary.md); the
model-path choke point that DOES hold is the proxy's `PROXY_SOCKET` (0600 AF_UNIX socket,
plus `uap proxy connect` to re-serve it on local TCP for clients that cannot speak
AF_UNIX).

## Escape hatches (operator-only)

| Variable | Effect |
|---|---|
| `UAP_SANDBOX_OFF=1` | Run the command as-is, no sandbox (for debugging). |
| `UAP_SANDBOX_ALLOW=/path:/other` | Extra writable prefixes — UNRECORDED (audited as `unrecordedAllow`; prefer `uap sandbox grant`). |
| `UAP_SANDBOX_WORKDIR=/path` | Override the resolved workdir. |
| `UAP_SANDBOX_NET=off` | Default the network mode for every run. Strictly `shared` or `off` — any other value fails LOUD (exit 2), never a silent downgrade to shared. |
| `PROXY_SANDBOX_UNREACHABLE_PREFIXES` | Change which tool prefixes are stripped (proxy side). |

Treat all of these as trusted-launch-environment settings — they widen the boundary, and
the model should never be able to set them for itself.

## Limits (be honest about them)

- **Network is restricted only in `--net off` mode.** In the default `shared` mode a
  sandboxed agent can still make outbound network calls; the sandbox's default is a
  *filesystem* boundary. Model-path gating is the proxy's job
  (`ANTHROPIC_PASSTHROUGH_MODELS=__local_only__` for the cloud path, and the
  `PROXY_SOCKET` unix surface for per-user permission gating).
- **The writable holes are real writable areas.** Anything under the workdir, `/tmp`, or
  `~/.cache`/`~/.claude`/`~/.npm` can be modified — including caches that persist across
  runs.
- **It only helps if you actually launch under it.** The workdir boundary is only real for
  sessions started with `uap sandbox`; a plain skip-permissions session has no filesystem
  boundary at all.

## Related

- `documentation/permissions.md` — all enforcement planes, the resource matrix, and the
  findings (including why the hook plane doesn't survive skip-permissions)
- [Worktree Workflow](WORKTREE_WORKFLOW.md) — the everyday (hook-based) isolation boundary
- [Policies](POLICIES.md) — the PreToolUse gate the sandbox backstops

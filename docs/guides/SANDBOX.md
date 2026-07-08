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
from sandboxed sessions" change from v1.63.0.)

## Escape hatches (operator-only)

| Variable | Effect |
|---|---|
| `UAP_SANDBOX_OFF=1` | Run the command as-is, no sandbox (for debugging). |
| `UAP_SANDBOX_ALLOW=/path:/other` | Extra writable prefixes. |
| `UAP_SANDBOX_WORKDIR=/path` | Override the resolved workdir. |
| `PROXY_SANDBOX_UNREACHABLE_PREFIXES` | Change which tool prefixes are stripped (proxy side). |

Treat all of these as trusted-launch-environment settings — they widen the boundary, and
the model should never be able to set them for itself.

## Limits (be honest about them)

- **Network is not restricted.** A sandboxed agent can still make outbound network calls;
  the sandbox is a *filesystem* boundary. Egress control is the proxy's job
  (`ANTHROPIC_PASSTHROUGH_MODELS=__local_only__` for the cloud path).
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

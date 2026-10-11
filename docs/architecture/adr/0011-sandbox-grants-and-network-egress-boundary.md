# ADR 0011: Per-session sandbox grants and the network egress boundary

- Status: Proposed
- Date: 2026-10-11 (branch `feature/356-bridge-p4-security`)
- Spec: bridge-program Phase 4 (D2 session authority, D1 network egress
  boundary), responding to the "agents with too much authority" gap in
  mtlynch.io's *Why Are Coding Agents So Dumb?*
- Supersedes: none — extends the P0 bubblewrap sandbox (`uap sandbox`) and
  the inference proxy; no existing schema changes.

## Context

`uap sandbox` (the P0 floor) is all-or-nothing authority: the workdir and
scratch are writable, everything else is EROFS, and the only escape hatch
was `UAP_SANDBOX_ALLOW=path:path` — an **unrecorded** env var: no session
scope, no expiry, no reason, invisible to the operator, surviving forever
in shell histories and hook templates. Meanwhile the sandbox shared the
host network by design (the agent must reach the proxy), so "too much
authority" had two open faces: unrecorded write holes and unrestricted
network egress.

The bar (EVOLUTION.md): **every new authority must state who consented.**

## Decision

### D2 — the consent ledger (`src/policies/sandbox-grants.ts`)

Every extra writable hole is a **grant**, recorded in
`.uap/sandbox-grants.json` at the main checkout root (the
`mainCheckoutRoot` anchor the attention queue established in ADR 0010 —
one ledger per checkout, shared by every surface; `UAP_SANDBOX_GRANTS`
pins an explicit file):

- `uap sandbox grant <path...> --session <id> --reason "..." [--ttl N]`
  creates a grant `{id, sessionId, paths[], reason, grantedBy, grantedAt,
  expiresAt}`. A grant is refused without a session, a stated reason, or a
  grantable target (existing absolute path; `/`, `/home`, `$HOME` itself
  are refused — an over-broad grant IS a sandbox escape). Default TTL 8h,
  hard cap 7d: authority is bounded by construction. An identical open
  grant is RENEWED, not duplicated.
- `uap sandbox --session <id> -- <cmd>` resolves the session's ACTIVE
  grants and opens exactly those `--bind` holes; `uap sandbox grants` /
  `revoke <id>` list and remove them. (The `--` separator is REQUIRED
  before the command: without it, the sandbox's own flags — `--session`,
  `--net`, `--ttl`, `--reason`, `--json` — are parsed as sandbox options,
  not passed through to the session command.)
- Every run appends a line to `.uap/sandbox-audit.jsonl` — the consent
  record: which grants were used, which network mode engaged, and any
  legacy `UAP_SANDBOX_ALLOW` entries labeled `unrecordedAllow` (still
  honored for compatibility, now named in the audit and the banner).
- Store rules inherited from ADR 0010's hardened queue: sanitize at ingest
  AND on load (the ledger is shared-write `.uap/` and a planted row must
  not become a kernel-writable hole), atomic writes with unique tmp
  names, malformed rows dropped, and an unreadable ledger treated as
  EMPTY — the safe direction for an authority store is least authority.
  "Sanitize" for this ledger means more than text fields: the load path
  RE-VALIDATES every path with the full grantable-path rule (absolute,
  existing, symlink-resolved, and not `/`, `/home`, or `$HOME` — the P4
  review caught that a string-prefix check alone would let a planted
  well-formed row bind the whole root) and refuses expiries beyond the
  hard TTL bound (a planted `expiresAt: "9999"` must never load).
  `UAP_SANDBOX_GRANTS_OFF=1` resolves zero grants; the sandbox's kernel
  boundary itself is never disabled by any of this.
- **Consent must come from the operator, not from inside the sandbox**
  (the security review's forgeability finding, three parts):
  1. `grant`/`revoke` are REFUSED when `UAP_SANDBOX_ACTIVE=1` — that env
     is set by the sandbox itself on the untrusted side, so an agent
     cannot write new authority or remove the operator's (listing stays
     allowed: read-only).
  2. The planner `--ro-bind`s the ledger and audit files over their host
     paths in EVERY sandbox namespace (a missing file gets `/dev/null`
     bound at the path). A bind-mounted file cannot be unlinked, replaced,
     or written inside the namespace, so the sandboxed agent can neither
     plant grant rows nor forge audit lines — the load-path re-validation
     checks SHAPE, but shape cannot establish WHO consented; the kernel
     mount does.
  3. Granted paths are re-resolved (`realpath`) at PLAN time and the
     resolved value is re-checked for breadth, closing the load→exec
     TOCTOU window where a concurrent process could swap a granted path
     for a symlink. (A microsecond window between this resolution and
     bwrap's own remains — accepted, documented.)
- Fail-closed everywhere authority is parsed: a garbage or negative
  `--ttl` is REFUSED (the old expression silently granted the 8h default
  — the wrong direction); `--ttl 0` floors to 1s; an unknown
  `UAP_SANDBOX_NET` value fails loud with exit 2 rather than silently
  meaning FULL network; and every persist is followed by a reload
  verification (a concurrent writer's lost update is retried once, then
  reported as failure — never a silent success).

### D1 — the network egress boundary

**Shipped: `--net off`** — `uap sandbox --net off` adds `--unshare-net`
with nothing brought up: no TCP, no DNS, not even loopback, at the kernel.
Any `connect()` fails. This is the complete boundary, intended for
untrusted code, evals, and data-only work; a harness that needs the model
fails loudly with connection refused, which is the boundary working. The
net mode defaults from `UAP_SANDBOX_NET=off`; every run's actual mode is
audit-logged (`netMode: shared|off`).

**Also shipped: the proxy's unix-socket surface** — `PROXY_SOCKET=<path>`
makes `anthropic_proxy.py` serve the SAME app on an AF_UNIX socket
(0600, parent dir 0700) alongside its TCP port: a permission-gated model
choke point for shared boxes. Stale-socket policy (hardened by the
security review): a live listener owns its path — and "live" includes a
socket that cannot be dialed (`EACCES`/`EPERM` is not proof of death, so
another user's socket is never evicted and impersonated); only a refused
or missing socket is a corpse. A non-socket file at the path is NEVER
unlinked (`PROXY_SOCKET` can arrive from the operator's env or the
sandbox-writable `.uap/proxy.env`, so a typo or planted value must not
become an arbitrary-file-delete primitive), and a group/other-writable
parent dir draws a warning (another local user could unlink or squat the
path). `uap proxy connect --socket <path> [--port N] --allow-anyone`
re-serves that socket on local TCP for clients that cannot speak
AF_UNIX — behind an explicit consent flag, because while the relay runs
it inverts the socket's gate: every local user can reach the model path
through the loopback port.

### D1's rejected design: the "only proxy" netns (and why)

The intended D1 was a netns cut with a SINGLE hole to the proxy: bwrap
`--unshare-net` plus a bind-mounted `PROXY_SOCKET`, with an in-namespace
relay re-serving the proxy on `127.0.0.1:4000`. **It cannot work on
rootless Linux**, and the failure is worth recording because the design
looks correct on paper:

1. **AF_UNIX pathname sockets are network-namespace-scoped.** The socket
   file bind-mounts fine, but `connect()` looks the listener up in the
   CONNECTING process's netns unix-socket table and finds nothing:
   empirically `ECONNREFUSED` from inside the namespace while the same
   socket answers on the host (verified on Linux 7.2, bwrap 0.11). The
   hole through the wall is a file that carries no reachability.
2. **bwrap closes every inherited fd** (verified: an fd handed to the
   child via `stdio` slot 3 arrives closed), so an SCM_RIGHTS broker that
   passes pre-connected proxy sockets across the wall is impossible too.
3. **The userspace network stacks cannot express the policy.**
   pasta/slirp4netns bridge a rootless netns to the host, but neither
   offers an outbound port allowlist — attaching one would give the
   sandbox FULL egress, the exact opposite of the boundary.

A boundary that requires a helper that isn't installed, or a mechanism
the kernel doesn't provide, would be a suggestion rather than enforcement.
So `--net proxy` was **cut, not faked**: the two REAL modes are `shared`
(no claim) and `off` (kernel-complete), and the model-path choke point
(`PROXY_SOCKET`, 0600) ships on the proxy side where permission gating
actually holds.

## Consequences

- Write authority beyond the workdir now requires a recorded, bounded,
  revocable consent — and the pre-P4 unrecorded escape hatch is still
  honored but is named in every audit line and banner.
- `--net off` gives untrusted-code runs a complete, kernel-enforced
  egress boundary today.
- Model-path gating becomes a socket permission problem (0600/0700) for
  multi-user or sandboxed-adjacent setups, rather than a TCP port anyone
  on the box can dial.
- The "agent session with ONLY model egress" use case remains open. The
  honest paths to it: (a) upstream `pasta`-class outbound filtering, if it
  ever grows port allowlists; (b) a setuid/privileged broker that can
  join the sandbox netns; (c) rootful sandboxing (a future
  `--net proxy,via:root` could revisit). None are rootless today, so none
  are claimed.
- Debt, accepted: the sandbox's `UAP_SANDBOX_ALLOW` continues to work
  unrecorded (compatibility), but every use is audited and named;
  the audit JSONL is append-only and unpruned (bounded by run count, not
  trimmed — the operator ships it to their own tooling).
- Follow-up (operator surface): the CLI is today the only grant consumer.
  A dashboard grants view — active authority per session, one click to
  revoke — is the natural next surface and a candidate for the P5
  "Surfaces" phase; the per-checkout-root anchoring already guarantees it
  would read the same ledger the sandbox does.
- Follow-up (trust anchoring, longer-term): the ledger and audit still
  live under the main checkout root — writable by the OPERATOR side of
  every run. The ro-bind closes the sandboxed side, and the load path
  validates shape; what neither can do is prove WHO wrote a row that
  predates the ro-bind (a historical plant opens until revoked). Anchoring
  consent to something outside the checkout's write reach (per-user state,
  or a signed ledger) is the structural fix and stays open on purpose —
  the P4 threat model closes the agent-side vectors; the operator-side
  residual is accepted and named here.
- Residual, accepted: the microsecond TOCTOU between the planner's
  `realpath` and bwrap's own bind (a concurrent process with write on a
  granted path's parent could still race it), and the unpruned audit JSONL
  (bounded by run count; the operator ships it to their own tooling).

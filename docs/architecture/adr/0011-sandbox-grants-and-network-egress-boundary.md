# ADR 0011: Per-session sandbox grants and the network egress boundary

- Status: Accepted
- Date: 2026-10-11
- Spec: session authority (D2) + network egress boundary (D1), responding to
  the "agents with too much authority" gap in mtlynch.io's *Why Are Coding
  Agents So Dumb?*
- Supersedes: none — extends the bubblewrap sandbox (`uap sandbox`) and
  the inference proxy; no existing schema changes.

## Context

`uap sandbox` (the base floor) is all-or-nothing authority: the workdir and
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

**`--net off`** — `uap sandbox --net off` adds `--unshare-net`
with nothing brought up: no TCP, no DNS, not even loopback, at the kernel.
Any `connect()` fails. This is the complete boundary, intended for
untrusted code, evals, and data-only work; a harness that needs the model
fails loudly with connection refused, which is the boundary working. The
net mode defaults from `UAP_SANDBOX_NET=off`; every run's actual mode is
audit-logged (`netMode: shared|off`).

**The proxy's unix-socket surface** — `PROXY_SOCKET=<path>`
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

- Write authority beyond the workdir requires a recorded, bounded,
  revocable consent. The legacy `UAP_SANDBOX_ALLOW` env still works for
  compatibility — every use is audited and named as unrecorded — and its
  entries get the same plan-time realpath re-check recorded grants get:
  a symlink entry binds its resolved target, and an entry whose resolution
  is `/`, `/home`, or `$HOME` is refused with an operator-visible note,
  never bound.
- `--net off` gives untrusted-code runs a complete, kernel-enforced
  egress boundary.
- Model-path gating becomes a socket permission problem (0600/0700) for
  multi-user or sandboxed-adjacent setups, rather than a TCP port anyone
  on the box can dial.
- The "agent session with ONLY model egress" use case remains open. The
  honest paths to it: (a) upstream `pasta`-class outbound filtering, if it
  ever grows port allowlists; (b) a setuid/privileged broker that can
  join the sandbox netns; (c) rootful sandboxing (a future
  `--net proxy,via:root` could revisit). None are rootless today, so none
  are claimed.
- The audit JSONL is bounded: every line carries a monotonic `seq`, and
  past 12,000 lines it compacts to the 10,000 newest event lines — plus
  the triggering event and one `audit-compaction` marker recording the
  drop, so the file lands at 10,002 — a pruned trail is an EXPECTED
  state, never a silent one. Seq numbering is continuous across
  compaction AND audit-file deletion: the trust anchor carries the
  witnessed seq high-water (`seqHi`), and each line numbers from the max
  of the file's last seq and the anchor's — a trail whose numbering can
  restart is a forgeable trail. Honest limits: concurrent audit appends
  can mint the same next-seq before either lands (a duplicate seq is
  evidence to investigate, not proof of planting on its own), and an
  older binary's next recorded mutation drops the optional `seqHi` field
  — it is recomputed from the file at the next current-binary mutation,
  which only matters if the audit file is deleted inside that
  mixed-version window.
- The dashboard's session view lists the active authority per session —
  id, session, remaining TTL, reason, paths, and the revoke command per
  grant — plus the trust-anchor verdict (an INTEGRITY MISMATCH renders
  red, rows listed-but-unverified, same contract as the CLI listing).
  The per-checkout-root anchoring guarantees it reads the same ledger the
  sandbox does.
- Tamper evidence (out-of-checkout anchor): every successful
  grant/renew/revoke writes a 0600 anchor at
  `$XDG_STATE_HOME/uap/sandbox-anchors/<hash-of-main-checkout-root>.json`
  (`UAP_SANDBOX_ANCHOR_DIR` pins the dir for tests) recording the SHA-256
  of the sanitized ledger as of that recorded operation. The key is the
  MAIN checkout root (the same `git rev-parse --git-common-dir` root the
  session-start hook and the python tools use), so a worktree session and
  its main checkout share ONE anchor for the ONE ledger they share — a
  worktree session is never silently unanchored, and a cross-cwd grant
  never fabricates a mismatch. A granted path covering the anchor dir is
  refused (a hole over the anchor would let the sandboxed side de-anchor
  itself silently). Verification (`uap sandbox grants` states it; the
  launch path enforces it) compares the on-disk ledger against the
  anchor: a mismatch means something with the CHECKOUT's write reach
  changed the ledger outside a recorded consent operation — new grants
  are refused, and the session resolves ZERO grant-derived holes
  (fail-closed; the kernel boundary is unaffected). A `revoke` on a
  mismatched ledger still removes authority (the safe direction) but
  re-anchors the remaining rows as the new baseline and names that at
  the moment it stops being detectable.
  What this remains honest about: it is tamper-EVIDENCE, not origin
  proof. The anchor lives in the user's state dir, so a same-user process
  OUTSIDE the checkout can still write it; a plant that predates the
  first anchor is baselined into it (bootstrap cannot verify history);
  and true origin proof (a different uid, a signed ledger, a hardware
  key) stays open on purpose — the threat model closes the agent-side
  vectors, and the anchor closes the checkout-write-reach side of the
  operator residual.
- Residual, accepted: the microsecond TOCTOU between the planner's
  `realpath` and bwrap's own bind (a concurrent process with write on a
  granted path's parent could still race it), and the anchor's same-user
  limit named above.

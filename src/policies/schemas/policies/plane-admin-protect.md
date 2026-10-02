# plane-admin-protect

**Category**: safety
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Default**: on
**Tags**: plane, credentials, admin, safety, droplet, owner-waiver

## Rule

A `Bash`/`run_bash`/`shell` command that **both** targets the Plane stack **and**
performs a credential mutation is blocked:

- Targets (substring match): `plane-app` (covers `plane-app-api-1`/`-worker`/`-beat`),
  `134.199.173.65`, `/opt/plane`, `plane-db`.
- Mutation verbs: `reset_password`, `set_password`, `changepassword`,
  `createsuperuser`, `passwd`.

The Plane admin account `admin@pay2u.com.au` (droplet `134.199.173.65`,
`/opt/plane/plane-app`) must **not** be reset or overridden unless the owner
explicitly asks for it in the current session.

**Allowed**: read-only Plane commands (`kubectl logs plane-app-worker`,
`docker exec plane-app-api-1 python manage.py showmigrations`, …) and any command
that merely *names* a credential verb in prose — a commit message, a
`uap memory store`, a script fed over a heredoc. The scan uses
`scannable_command()`, which strips heredoc bodies and multi-word quoted blobs,
so prose that mentions the verbs is not refused.

**Escape hatch (owner approval).** Write `policies/waivers/plane-admin-reset`
containing a line `expires: YYYY-MM-DD` (today or later), then retry. The waiver
is a file the OWNER writes; an agent writing it without an explicit owner request
in the current session violates the policy even though the gate would pass. A
waiver that is expired, missing its `expires:` line, or unreadable fails the gate
closed (refused), never allowed and never a crash.

**Known limits.** This is a text gate over a language with unbounded ways to say
the same thing. A mutation quoted inside a plain `ssh host "..."` with no
shell-exec token, or routed through `eval`/base64, evades every text rule by
construction. Treat this as raising the cost, not as a boundary.

## Why

Observed live (2026-09-24 and 2026-09-30): agents independently ran
`docker exec plane-app-api-1 python manage.py ... set_password admin@pay2u.com.au`
and overwrote the owner's password TWICE. The owner had to ask for a reset. UAP
memory stores a PROTECT note; this enforcer makes that note mechanical rather
than a reminder an agent can forget or route around.

## Enforcement

Python enforcer `plane_admin_protect.py` (Bash/run_bash/shell ops only). Emits a
specific remediation: the refusal names the matched target and verb and points at
the owner-waiver path. Install with `uap policy install plane-admin-protect`,
which auto-attaches the enforcer from `src/policies/enforcers/plane_admin_protect.py`.
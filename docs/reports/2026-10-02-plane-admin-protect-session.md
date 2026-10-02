# Session summary — Plane Admin Protect enforcer (hardened + shipped to force)

Date: 2026-10-02. Repo: `universal-agent-protocol` (UAP). Consuming project: `pay2u`.

## Why

The Plane admin account `admin@pay2u.com.au` (droplet `134.199.173.65`,
`/opt/plane/plane-app`) had its credentials mutated by an agent command
(`docker exec plane-app-api-1 python manage.py changepassword …`). A guard
policy — `plane-admin-protect` — existed but was weak: no expiry on its waiver,
no fail-closed behaviour, no tests, and the copy the gate actually executes had
drifted from the source.

## What was built

### 1. Hardened enforcer — `src/policies/enforcers/plane_admin_protect.py` (132 lines)

- Shell ops only (`bash`/`run_bash`/`shell`/`execute_command`/`terminal`); everything
  else allows.
- Blocks only when a command **both** targets the Plane stack **and** carries a
  credential-mutation verb:
  - targets: `plane-app`, `134.199.173.65`, `/opt/plane`, `plane-db`
  - verbs: `reset_password`, `set_password`, `changepassword`, `createsuperuser`, `passwd`
- Scans via `scannable_command()` so quoted payloads are visible.
- Owner waiver `policies/waivers/plane-admin-reset` must carry `expires: YYYY-MM-DD`:
  - valid → allow, with `waiver valid until <date>`
  - expired / missing expiry / **unreadable** → **fails CLOSED** (`allowed:false`,
    exit 2, `route:"owner-waiver"`, `waiverHint`) — never a crash (exit 1), never a
    silent allow.
- Documents its own limit: text scan raises cost, it is not a boundary (see below).

### 2. Policy schema doc — `src/policies/schemas/policies/plane-admin-protect.md`

Category `safety`, level `REQUIRED`, stage `pre-exec`, default `on`, tags
`plane, credentials, admin, safety, droplet, owner-waiver`. States the rule, the
target/verb lists, and the allowed read-only cases.

### 3. Tests — `tools/agents/tests/test_plane_admin_protect.py` (10 tests, all green)

Observed incident spelling blocked · `bash -c` wrapper blocked · non-shell op
allowed · read-only Plane command allowed · **prose** naming a verb NOT blocked
(`git commit -m "refused to passwd /opt/plane admin"`, `uap memory store …`) ·
heredoc body naming a verb NOT blocked · valid waiver allows · expired waiver
fails closed · missing expiry fails closed · unreadable waiver fails closed
without crashing.

Registered in `package.json` → `test:enforcers` (the suite-coverage guard
`test_enforcer_suite_coverage` passes, so the module is genuinely in the gate).

## Verification

- `python3 -m unittest …test_plane_admin_protect` → 10/10 OK.
- `npm run test:enforcers` → **Ran 1348 tests, OK (skipped=1)**.
- `npm run build` (tsc) → clean.
- Indirection matrix (15 real commands, temp repo root): blocked — heredoc that
  writes the mutation script, `T=…; V=…` variable indirection, `printf … | sh`,
  `docker compose exec`, `kubectl exec`, `ansible plane-app`. Allowed —
  `bash r.sh` (script contents invisible), base64 payload, `ssh host '…'` with no
  shell-exec token, `ansible all -m shell -a …` (no target token), read-only
  Plane commands, prose in commit messages / memory stores, target-only, verb-only.
  Net: the guard catches the realistic accidental paths; deliberate evasion via
  an indirect payload is out of scope and is stated in the enforcer docstring.
- End-to-end through the real gate in `pay2u`
  (`.claude/hooks/uap-policy-gate.sh`, `tool_name`/`tool_input` payload):
  mutation command → **blocked** with the owner-waiver hint; read-only Plane
  commands → allowed (only the unrelated `expert-review-required` gate fires).

## Deployed to force in pay2u

`uap policy add-tool -p 7c26d0f7-3adc-4b36-9ebc-5ea554b6a687 -t plane_admin_protect -c <src>`
run from the `pay2u` root. Result:

- `.policy-tools/7c26d0f7-…_plane_admin_protect.py` sha `63841c556f3ba71c` == source sha.
- `policies.db` `executable_tools.code` byte-identical to the materialized copy.
- `.integrity.sha256` manifest rewritten to match (the gate verifies and
  self-repairs against it, so the fix is now actually in force, not just merged).

Re-verified end-to-end through the live gate in `pay2u`:

| payload | exit | verdict |
| --- | --- | --- |
| `docker exec plane-app-api-1 python manage.py createsuperuser` | 2 | blocked (owner-waiver hint) |
| `kubectl logs deploy/plane-app-worker -n plane --tail=50` | 0 | allowed |

Canonical row is now `709d51b3-…` / `plane-admin-protect` (active, matches the
built-in matrix slug, hardened code in force); `7c26d0f7-…` (`Plane Admin
Protect`) is inactive. Both materialized copies are identical to source.

## Open items (not done)

1. **No waiver exists**: neither `pay2u/policies/waivers/` nor the UAP root has
   `plane-admin-reset`. That is correct default posture (owner approval required);
   create it only with explicit owner instruction and a real `expires:` date.
2. **UAP changes are uncommitted** (`package.json` modified; enforcer, schema doc
   and test untracked). Commit + push not performed — needs an explicit go-ahead.
3. **Gate fail-open for this enforcer**: `must_fail_closed()` in
   `.claude/hooks/uap-policy-gate.sh` fail-closes only for
   `enforcement_self_protect` (when sensitive) and `schema_diff_gate` (on
   commit/push). A plane enforcer that errors or is missing is read as ALLOW.
   The integrity self-repair covers the missing/stale-copy path; an import-time
   crash of this enforcer specifically would still pass the command.
4. **Known, documented evasion surface** (accepted, not a boundary): `bash r.sh`
   where `r.sh` holds the mutation, base64 payloads, and `ssh host '<verb>'`
   with no shell-exec token. Text scan is a cost-raiser, stated in the enforcer
   docstring.
5. `pay2u` gate blocks inline `UAP_NO_REVIEW=1`; a review artifact or waiver is
   needed before shipping there.

## Resolved since first draft

- Duplicate policy rows: `709d51b3-…` (`plane-admin-protect`, the built-in slug)
  is the single active row; `7c26d0f7-…` is inactive. No double verdict.
- Stale `rtk_wrap` manifest entry: no longer present in
  `pay2u/.policy-tools/.integrity.sha256`, no `rtk_wrap.py` in `.policy-tools/`,
  and the last `restored: …rtk_wrap.py` log line is ~6 days old — the per-call
  restore churn has stopped.
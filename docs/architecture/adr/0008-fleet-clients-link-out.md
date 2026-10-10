# ADR 0008: Dashboard fleet "Clients" tab ships as link-out, not multi-root

- **Status**: Accepted
- **Date**: 2026-10-10 (branch `feature/348-dashboard-fleet-clients`)

## Context

The dashboard server (`uap dashboard serve`) is single-project: every route
reads `process.cwd()` captured at start. The operator runs many UAP-managed
client folders as siblings on disk and wants one surface that shows each
client's job queue (tasks) and delivery processes, with the ability to
switch to any of them.

Two shapes solve this:

- **Option A — multi-root host**: the host server accepts a root parameter
  on every API call and re-scopes all panels in place. Largest payoff, but
  it turns the host into a cross-project write surface: every existing
  mutation route (`/api/deliver/launch`, task mutations, policy toggles)
  would need a second authority dimension, and the mutation token would
  suddenly grant control of every sibling project at once.

- **Option B — fleet overview + link-out**: the host stays single-project
  and gains a read-only `GET /api/clients` that summarizes the fleet
  (deliver-run states, queue depth, git, activity, health probe). Opening a
  client spawns that client's OWN `uap dashboard serve` on a loopback port
  (registry-only paths) and links out to it. Full control exists per
  client, but only through each client's token-gated instance.

## Decision

Ship Option B. The host server gains no cross-project write authority; the
only wire-reachable cross-client action is `POST /api/clients/serve`
(token-gated, resolved strictly against the client registry — never a
raw path from the wire). Discovery is auto-scan of the scan root (default:
the host's parent directory, ignore-list filtered) merged with manual
entries in `~/.uap/clients.json` (`uap clients add/remove/list/scan`).

Consequences and guards:

- **Sticky ports**: spawned dashboards record their port in the registry
  (`ports` map), and computed ports skip claimed ones — a fleet change
  (new folder, rename) can never silently move a live dashboard's port,
  which would orphan the old process and wedge the new assignment.
- **Root-matched probes**: liveness is true only when the answering
  dashboard reports the expected project root, so a foreign listener on a
  candidate port can never be link-mistaken for the client.
- **Spawn is registry-only and argv-fixed** (`dashboard serve --port N
  --host 127.0.0.1`): no shell, no path from the wire.
- **Host never writes into client projects** — the earlier `.uap/dash.pid`
  write was dropped; nothing reads it and it breached the invariant.
- **Disclosure scope** (recorded for the security review): `GET
  /api/clients` is unauthenticated and CORS-open exactly like
  `/api/dashboard`, but it widens exposure from one project to every
  sibling (absolute paths, branches, activity). On `--host 0.0.0.0` binds
  this is LAN-visible; operators choosing that bind accept the wider
  read. If the CORS-open-read posture is ever tightened, this route
  belongs in that sweep. No secrets, tokens, or pids are in the payload.
- **Environment**: spawned children inherit the operator's environment
  (including `UAP_DASHBOARD_TOKEN`, deliberately kept so scripted fleet
  control works) except the host's `UAP_CLIENTS_*` test overrides, which
  are scrubbed so the child scans its own siblings.

## Alternatives rejected

- **Multi-root host (Option A)**: rejected for the write-surface blast
  radius above. Note this change prepares rather than blocks it — the
  per-project read surface (`getTaskData(cwd)`, `listRuns(root)`) was
  already root-parameterized, and the registry's `ClientEntry` model is
  reusable if in-place switching is ever wanted.
- **Federated static links (no spawn)**: rejected because the operator
  wants one click from the fleet view to a live dashboard; requiring a
  manual `uap dashboard serve` per client defeats the point.

## Follow-ups

Completed on this branch:

- **`uap clients stop` + tab Stop action** (spawned-instance teardown):
  spawn-on-demand records the child pid in the registry (`pids` map —
  host-owned bookkeeping in `~/.uap/clients.json`, never a write into the
  client project). Stop requires BOTH a root-matched live probe and pid
  ownership verification (`/proc/<pid>/cwd` must be the client root) before
  SIGTERM — a recycled pid is never killed; on mismatch or missing evidence
  it refuses and names the port for a manual stop. Stale pid records are
  cleared opportunistically whenever a probe shows the dashboard gone.
- **`resolveUapBin` extracted** to `src/utils/resolve-uap-bin.ts`
  (`controls.ts` and `client-registry.ts` share it; the util lives one level
  under `dist/` so the same-install `<root>/dist/bin/cli.js` resolution is
  unchanged).

None outstanding.

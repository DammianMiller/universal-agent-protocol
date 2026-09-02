# Multi-Agent Coordination

> UAP v1.224.0

> **🏭 Where this fits:** LINE COORDINATION — the station where parallel agents on the [delivery pipeline](./DELIVERY_PIPELINE.md) quietly step on each other: two of them editing the same file, duplicating work, or deadlocking at merge. **What it delivers:** agents register, announce what they're about to touch, and check for overlaps *before* they start — so the line runs many workers at once and still stays conflict-free.

When multiple agents work a codebase in parallel, the expensive failure is two
of them editing the same file at the same time and colliding at merge. UAP's
coordination layer lets agents **register**, **announce** what they intend to
work on, and **check for overlaps** before they start — so parallel work stays
conflict-free.

The coordination modules live in
[`src/coordination/`](../../src/coordination/): the shared
[`service.ts`](../../src/coordination/service.ts) backed by a SQLite store
([`database.ts`](../../src/coordination/database.ts)), agent lifecycle and
auto-registration ([`auto-agent.ts`](../../src/coordination/auto-agent.ts)),
the deploy batcher ([`deploy-batcher.ts`](../../src/coordination/deploy-batcher.ts)),
and routing/pattern helpers. The CLI entry points are
[`src/cli/agent.ts`](../../src/cli/agent.ts) and
[`src/cli/coord.ts`](../../src/cli/coord.ts).

## The model

- **Agents** register with a name, optional capabilities, and an optional
  worktree branch, and receive an `AGENT_ID`. They send periodic heartbeats so
  stale agents can be cleaned up.
- **Work announcements** declare an *intent* (`editing`, `reviewing`,
  `refactoring`, `testing`, `documenting`) against a *resource* (a file path or
  other identifier), optionally with affected files, a description, and an
  estimate in minutes.
- **Overlap detection** compares your announced resource against active work
  from other agents and returns a conflict-risk assessment plus a suggestion.
- **Messaging** lets agents broadcast to a channel or send directly to another
  agent.

## The announce / overlaps workflow

The recommended flow, printed by `uap agent register` itself — think of it as
each worker calling out "I've got this one" before reaching for a part:

```bash
# 1. Register (once per agent)
uap agent register --name reviewer-1 --worktree feature/042-foo
#   → prints AGENT_ID=<id>

# 2. Announce what you're about to work on
uap agent announce --id <id> --resource src/server.ts --intent editing \
  --description "add request logging" --files src/server.ts --minutes 20

# 3. Check overlaps before editing (anyone can run this, no ID needed)
uap agent overlaps --resource src/server.ts

# 4. When finished, release the resource
uap agent complete --id <id> --resource src/server.ts
```

`announce` immediately reports whether the resource is **CLEAR** or has
**overlapping work**. For each overlap it lists the other agents, their intent,
their worktree branch, a conflict-risk badge (`low` → `critical`), and a
suggestion. When risks exist it may also surface collaboration suggestions,
including a recommended merge order.

`complete` notifies other agents that the resource is free, so they can safely
merge.

## CLI reference: `uap agent`

Agent lifecycle, work coordination, and communication.

```bash
uap agent <action> [options]
```

| Action       | Purpose | Required options |
| ------------ | ------- | ---------------- |
| `register`   | Register a new agent | `--name` |
| `auto`       | Auto-register an agent that heartbeats (30s) and deregisters on exit | — (`--name` optional) |
| `heartbeat`  | Send a liveness heartbeat | `--id` |
| `status`     | Show one agent (`--id`) or all active agents + active work | — |
| `announce`   | Announce work intent on a resource | `--id`, `--resource`, `--intent` |
| `complete`   | Mark work complete on a resource (notifies others) | `--id`, `--resource` |
| `overlaps`   | Show overlaps for a resource, or all active work if none given | — |
| `broadcast`  | Broadcast a message to a channel | `--id`, `--channel`, `--message` |
| `send`       | Send a direct message to another agent | `--id`, `--to`, `--message` |
| `receive`    | Read pending messages | `--id` |
| `deregister` | Remove an agent | `--id` |

Key options:

- `--name`, `-i/--id`, `--capabilities` (comma-separated), `-w/--worktree`
  (branch) — registration.
- `--resource`, `--intent` (`editing|reviewing|refactoring|testing|documenting`),
  `--description`, `--files` (comma-separated), `--minutes` — announcing work.
- `-c/--channel` (`broadcast|deploy|review|coordination`), `--message`,
  `-t/--to`, `--priority` — messaging.

```bash
# Inspect everything currently in flight
uap agent status

# Message another agent directly
uap agent send --id <id> --to <other-id> --message "ready to merge src/a.ts"

# Broadcast on the review channel
uap agent broadcast --id <id> --channel review --message '{"action":"need-review"}'
```

## CLI reference: `uap coord`

System-wide coordination status and maintenance.

```bash
uap coord <status|flush|cleanup> [options]
```

| Action    | Purpose |
| --------- | ------- |
| `status`  | Show active agents, resource claims, the deploy queue, and unread-message counts |
| `flush`   | Force-execute all pending deploys (see [Deploy Batching](./DEPLOY_BATCHING.md)) |
| `cleanup` | Mark stale agents as failed and remove expired claims, old messages, and completed entries |

```bash
uap coord status -v
uap coord cleanup
```

## CLI reference: `uap coordination`

Focused overlap checks and resolution.

```bash
uap coordination <check|resolve> [options]
```

### `check` — detect overlapping work

```bash
uap coordination check [--agents <ids|names>] [-r|--resource <resource>] [-v] [--json]
```

Filters active work by agent and/or resource, then reports overlaps with their
conflict risk and suggestions. `--json` emits machine-readable output.

### `resolve` — broadcast a resolution

```bash
uap coordination resolve <overlapId> [--action <assign|merge|delegate>] [--json]
```

`<overlapId>` is the resource path. The resolution (default `merge`) is
broadcast on the `coordination` channel so other agents can act on it.

```bash
uap coordination check --resource src/server.ts
uap coordination resolve src/server.ts --action merge
```

## Related

- [Deploy Batching](./DEPLOY_BATCHING.md) — how coordinated commits/pushes are
  batched to avoid merge conflicts.
- `uap deliver --coordinate` registers a convergence run with the coordination
  layer (announce + heartbeat + overlap detection); see
  [Local Models](./LOCAL_MODELS.md).

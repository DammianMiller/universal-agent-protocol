# Deploy Batching

> UAP v1.91.0

> **🏭 Where this fits:** LINE COORDINATION → SHIPPING — this is the station
> where parallel agents collide: two push to the same branch within seconds and
> one gets rejected, or a burst of redundant deploys stampedes CI. **What it
> delivers:** git and deploy actions are queued, squashed, and deduplicated into
> one ordered batch — so many agents can ship down the same line without
> trampling each other.

When several agents work in parallel, they all want to commit, push, merge, and
deploy at roughly the same time. That's the moment a normal agentic workflow
falls apart at the end of the [delivery pipeline](./DELIVERY_PIPELINE.md). Left
unmanaged, it produces two failure modes:

- **Merge conflicts** — two agents push to the same branch within seconds of
  each other and the second push is rejected (or worse, races into a conflicted
  state).
- **Thundering deploys** — a burst of redundant deploys, duplicate workflow
  triggers, and a noisy commit history full of one-line commits.

The deploy batcher solves this by *queueing* git/deploy actions and grouping
them inside short, per-action-type time windows. Commits to the same branch are
squashed, duplicate pushes and workflow triggers are deduplicated, and the
result is executed as a single ordered batch — the line coordinator that keeps
the shipping station orderly.

The implementation lives in
[`src/coordination/deploy-batcher.ts`](../../src/coordination/deploy-batcher.ts),
with the CLI surface in [`src/cli/deploy.ts`](../../src/cli/deploy.ts).

## How it works

1. An agent **queues** an action (`commit`, `push`, `merge`, `deploy`, or
   `workflow`) against a target (branch, environment, or workflow name).
2. Each action gets an `execute_after` timestamp computed from its
   type-specific batch window. Until that time passes, the action stays
   `pending`.
3. If a *similar* pending action already exists for the same type + target, the
   new one is **merged** into it instead of being queued separately:
   - `commit` actions are squashed (messages concatenated, file lists unioned).
   - `push` actions to the same branch are merged.
   - `workflow` triggers are deduplicated.
4. **Creating a batch** collects every pending action whose window has elapsed,
   groups them by `actionType:target`, squashes where possible, and assigns a
   batch ID.
5. **Executing a batch** runs the actions. State-dependent actions (`commit`,
   `push`, `merge`, `deploy`) run sequentially in priority order;
   `workflow` triggers can run in parallel.

Actions are executed with real tooling: `git add` / `git commit` / `git push`
(`--force-with-lease` when forced) / `git merge`, `gh workflow run`, and a
configurable deploy command. Each external command runs under a timeout
(default 300000 ms / 5 minutes) so a hung process can't block the pipeline.

## Batch windows per action type

Each action type has its own default window. Shorter windows favor speed;
longer windows favor more batching (fewer, larger operations).

| Action type | Default window | Rationale |
| ----------- | -------------- | --------- |
| `commit`    | 30000 ms (30s) | Allows squashing multiple commits |
| `push`      | 5000 ms (5s)   | Fast for PR creation |
| `merge`     | 10000 ms (10s) | Moderate safety buffer |
| `workflow`  | 5000 ms (5s)   | Fast workflow triggers |
| `deploy`    | 60000 ms (60s) | Safety buffer for deployments |

These defaults are defined as `DEFAULT_DYNAMIC_WINDOWS` in
`deploy-batcher.ts`. Windows below 1000 ms or above 300000 ms trigger a
validation warning.

### Configuring windows

Windows can be set per project in `.uap.json` under `deploy.batchWindows`:

```json
{
  "deploy": {
    "batchWindows": {
      "commit": 60000,
      "push": 3000,
      "merge": 15000,
      "workflow": 5000,
      "deploy": 60000
    }
  }
}
```

Any window not set in the file falls back to an environment variable, then to
the default:

| Window     | Environment variable          |
| ---------- | ----------------------------- |
| `commit`   | `UAP_DEPLOY_COMMIT_WINDOW`    |
| `push`     | `UAP_DEPLOY_PUSH_WINDOW`      |
| `merge`    | `UAP_DEPLOY_MERGE_WINDOW`     |
| `workflow` | `UAP_DEPLOY_WORKFLOW_WINDOW`  |
| `deploy`   | `UAP_DEPLOY_DEPLOY_WINDOW`    |

The batcher also exposes named profiles (`fast`, `safe`, `default`) at the API
level via `DeployBatcher.fromProfile(...)`.

## Urgent mode

Urgent mode collapses every window to its minimum so a time-sensitive change
fast-tracks through the queue:

| Action type | Urgent window |
| ----------- | ------------- |
| `commit`    | 2000 ms       |
| `push`      | 1000 ms       |
| `merge`     | 2000 ms       |
| `workflow`  | 1000 ms       |
| `deploy`    | 5000 ms       |

Toggle it from the CLI:

```bash
uap deploy urgent --on    # enable fast windows
uap deploy urgent --off   # restore default windows
```

> Note: `uap deploy urgent` applies to the batcher instance it creates, so it
> is most useful as part of a session that immediately queues and flushes.

## CLI reference: `uap deploy`

```bash
uap deploy <queue|batch|execute|status|flush|config|set-config|urgent> [options]
```

### `queue` — add an action to the batch queue

```bash
uap deploy queue \
  --agent-id <id> \
  --action-type <commit|push|merge|deploy|workflow> \
  --target <branch|environment|workflow> \
  [options]
```

`--agent-id`, `--action-type`, and `--target` are required. Type-specific
options:

| Option              | Applies to | Meaning |
| ------------------- | ---------- | ------- |
| `-m, --message`     | `commit`   | Commit message |
| `-f, --files`       | `commit`   | Comma-separated file list |
| `-r, --remote`      | `push`     | Git remote (default `origin`) |
| `--force`           | `push`     | Force push (`--force-with-lease`) |
| `--ref`             | `workflow` | Git ref to run the workflow against |
| `--inputs`          | `workflow` | Workflow inputs as JSON |
| `-p, --priority`    | all        | Priority 1–10 (default 5) |

```bash
uap deploy queue --agent-id agent-123 --action-type commit --target main \
  -m "feat: add batcher" -f "src/a.ts,src/b.ts"
```

### `batch` — create a batch from ready actions

```bash
uap deploy batch [-v|--verbose]
```

Collects pending actions whose window has elapsed and prints the new batch ID
plus the command to execute it.

### `execute` — run a specific batch

```bash
uap deploy execute --batch-id <id> [--dry-run]
```

`--batch-id` is required. Reports executed/failed counts, duration, and any
per-action errors.

### `status` — inspect the queue

```bash
uap deploy status [-v|--verbose]
```

Shows pending (unbatched) actions grouped by type, pending batches, and a
summary.

### `flush` — batch and execute everything pending

```bash
uap deploy flush [-v|--verbose] [--dry-run]
```

Repeatedly creates and executes batches until the queue is empty. This is the
one-shot "do it all now" command.

### `config` / `set-config` — view and change windows

```bash
uap deploy config
uap deploy set-config --message '{"commit":60000,"push":3000}'
```

`set-config` takes a JSON object of window values (ms); every value must be a
positive number. Changes apply to the current batcher instance.

### `urgent` — toggle fast windows

```bash
uap deploy urgent --on
uap deploy urgent --off
```

## Related

- `uap coord flush` is an alias-style shortcut that flushes all pending
  deploys (see [Coordination](./COORDINATION.md)).
- `uap deliver --deploy` queues a commit of applied files into the batcher on a
  successful convergence run (see [Local Models](./LOCAL_MODELS.md)).

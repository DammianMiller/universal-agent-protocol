# Policies

> Applies to UAP v1.163

> **🏭 Where this fits:** CROSS-CUTTING — the executable rules bolted to every station of the [delivery pipeline](./DELIVERY_PIPELINE.md). In a normal agentic workflow the "rules" live in a prose prompt the model is free to ignore; that's how work escapes isolation, skips tests, or ships without review. **What it delivers:** each rule is a Python enforcer that actually inspects an operation and can *block* it before it runs — worktree isolation, test deltas, expert review, schema diffs, artifact hygiene, and more — so the guardrails hold instead of merely being suggested.

UAP policies are **executable gates, not prose**. Each policy can carry a Python
enforcer that inspects an operation and decides whether it may proceed. A
`PreToolUse` hook queries the policy store and runs the relevant enforcers
before a tool call executes; an enforcer that exits with status `2` blocks the
call.

The engine lives in
[`src/policies/policy-gate.ts`](../../src/policies/policy-gate.ts); enforcers
live in [`src/policies/enforcers/`](../../src/policies/enforcers/); the CLI is
in [`src/cli/policy.ts`](../../src/cli/policy.ts).

## The policy-gate model

The flow is **hook to DB to enforcer to block**:

1. **Hook** — A `PreToolUse` hook fires before a tool call (Edit, Write, Bash,
   etc.). Tools registered through the enforced tool router
   ([`src/policies/enforced-tool-router.ts`](../../src/policies/enforced-tool-router.ts))
   are automatically routed through the policy gate.
2. **DB** — The gate
   ([`PolicyGate`](../../src/policies/policy-gate.ts)) loads all active policies
   from the policy store (a SQLite-backed DB, cached with a short TTL) and
   filters them to the ones matching the current enforcement stage
   (`pre-exec`, `post-exec`, `review`, or `always`).
3. **Enforcer** — Each matching policy that has an attached Python enforcer is
   invoked as `python3 <enforcer>.py --operation <op> --args <json>`. Enforcers
   receive the operation name and its arguments and return a JSON verdict.
4. **Block** — An enforcer emits `{"allowed": true, ...}` and exits `0` to
   allow, or `{"allowed": false, "reason": ...}` and **exits `2` to block** (see
   the shared `emit()` helper in
   [`src/policies/enforcers/_common.py`](../../src/policies/enforcers/_common.py)).
   When a `REQUIRED` policy blocks, the gate raises a `PolicyViolationError` and
   the tool call never runs. Every check is written to an audit trail.

Task-completion operations (anything that looks like merge / deploy / release /
"mark done") are automatically re-checked at the `review` stage, so completion
gates fire even if the operation was issued at `pre-exec`.

### Cooperative-guardrail caveat

The policy gate is a **cooperative-agent guardrail, not a hard security
boundary.** It steers well-behaved agents away from unsafe or out-of-process
actions; it does not sandbox a hostile process. Enforcers also honor explicit
overrides (for example the `worktree-required` enforcer respects
`UAP_NO_WORKTREE=1`). Treat policies as guardrails that keep cooperating agents
on the rails — not as a containment mechanism against untrusted code.

## The enforcers

Each enforcer guards a specific station of the pipeline. The enforcers in
[`src/policies/enforcers/`](../../src/policies/enforcers/) group as follows.
`_common.py` is shared helper code, not an enforcer.

### Workflow & isolation

| Enforcer | What it gates |
|----------|---------------|
| `worktree_required` | Edit/Write/MultiEdit must target a `.worktrees/` path |
| `task_required` | A UAP task must be `in_progress` before mutating work |
| `coord_overlap` | Checks for in-flight agent path reservations (parallel-agent overlap) |
| `branch_freshness` | Worktree edits blocked once the branch drifts too far from the integration branch (warn 50, block 200) |
| `delivery_enforcement` | Route substantive coding through `uap deliver` |

### Plan discipline

| Enforcer | What it gates |
|----------|---------------|
| `memory_before_plan` | Plans require a recent `uap memory query` |
| `codebase_read_before_plan` | Plans require prior reads of the target paths |
| `validate_plan_before_build` | A plan must be validated before building |

### Quality & review gates

| Enforcer | What it gates |
|----------|---------------|
| `test_gate` | Changed services need accompanying test deltas |
| `schema_diff_gate` | Schema/pool changes must pass `uap schema-diff` |
| `expert_review_required` | A parallel expert review must precede ship |
| `architecture_review` | Merge / PR-ready operations need an architecture review when the diff warrants it |

### Hygiene & artifacts

| Enforcer | What it gates |
|----------|---------------|
| `artifact_hygiene` | Block binary artifacts outside curated directories |
| `doc_live_over_report` | Block new `*_REPORT` / `*_COMPLETE` / `*_SUMMARY` / `*_PLAN` markdown files |
| `session_memory_write` | Code-changing sessions must write a lesson to memory |

### Tooling & routing

| Enforcer | What it gates |
|----------|---------------|
| `mcp_router_first` | MCP tools must be loaded on demand |
| `rtk_wrap` | Heavy CLIs must be invoked via `rtk` |
| `parallel_reads` | Nudge when serial read fan-out is detected |

### Infrastructure

| Enforcer | What it gates |
|----------|---------------|
| `iac_parity` | Live-state changes must have a matching infrastructure-as-code diff |
| `cluster_routing` | Cluster tooling context must match the component domain |

> The `architecture_review` enforcer file is stored with a policy-ID prefix
> (`<uuid>_architecture_review.py`) because it is attached to a specific
> installed policy; the others are named directly after their policy slug.

## The `uap policy` CLI

All commands are subcommands of `uap policy`, implemented in
[`src/cli/policy.ts`](../../src/cli/policy.ts).

### Inspect

```bash
uap policy list      # list all policies with status, level, category, stage, version
uap policy status    # summary of enabled/disabled plus enforcement stages
```

### Install & attach

`install` reads a built-in policy markdown file and stores it. If a Python
enforcer with the matching name lives in `src/policies/enforcers/`, it is
auto-attached.

```bash
uap policy install worktree-enforcement
```

Add a policy from an arbitrary markdown file, or attach tool code to an existing
policy:

```bash
uap policy add --file ./my-policy.md --category custom --level RECOMMENDED --tags "a,b"
uap policy add-tool --policy <id> --tool <name> --code ./enforcer.py
```

### Enable / disable / toggle

```bash
uap policy enable <id>      # turn a policy on
uap policy disable <id>     # turn a policy off
uap policy toggle <id>      # flip current state
uap policy toggle <id> --on
uap policy toggle <id> --off
```

### Tune enforcement

```bash
uap policy level <id> --level REQUIRED      # REQUIRED | RECOMMENDED | OPTIONAL
uap policy stage <id> --stage pre-exec      # pre-exec | post-exec | review | always
```

Only `REQUIRED` policies can block an operation; `RECOMMENDED` and `OPTIONAL`
checks are recorded but do not deny the call.

### Check & audit

```bash
uap policy check --operation Write --args '{"file_path":"src/x.ts"}'   # dry-run a gate
uap policy audit --limit 20                                            # enforcement audit trail
uap policy audit --policy <id>                                         # filter to one policy
```

### Other

```bash
uap policy get-relevant --task "ship the api" --top 3     # context-relevant policies
uap policy convert --input <id|file.md> --output out.md   # render to CLAUDE.md format
```

## How to add, enable, and disable a policy

1. **Author** a policy markdown file (and, optionally, a Python enforcer named
   after the policy slug with hyphens replaced by underscores).
2. **Install / add** it: `uap policy install <name>` for a built-in, or
   `uap policy add --file <path>` for a custom one. A co-located enforcer is
   auto-attached on install; otherwise attach it with `uap policy add-tool`.
3. **Set its teeth**: `uap policy level <id> --level REQUIRED` so it can block,
   and `uap policy stage <id> --stage <stage>` to choose when it fires.
4. **Enable / disable** at any time with `uap policy enable <id>` /
   `uap policy disable <id>` (or `toggle`). Disabled policies are skipped by the
   gate entirely.

Changes invalidate the gate's policy cache immediately, so they take effect on
the next tool call.

## Changing an enforcer's code

Two things trip people up here, and both fail *silently* — the source looks
fixed while the gate keeps enforcing the old behaviour.

**1. The gate does not run `src/policies/enforcers/*.py`.** It runs
`.policy-tools/<policyId>_<toolName>.py`, a separate materialized copy (plus a
snapshot in the `code` column of `policies.db`). Editing the source changes
nothing on its own — re-run `uap policy install <slug>` to refresh the
executable copy:

```bash
uap policy install workdir-scope
grep -l _my_new_function .policy-tools/*workdir_scope.py   # verify it took
```

**2. Run that install from the MAIN checkout, not a worktree.** The policy gate
anchors runtime state — `policies.db` and `.policy-tools/` — to `MAIN_ROOT`, so
that every worktree enforces the same policies. `uap policy install` run from
inside a worktree gets this wrong in *both* directions, while still printing
success:

- it **reads** the enforcer source from the main checkout (not the worktree's
  edited copy), and
- it **writes** the materialized copy into a worktree-local `.policy-tools/`
  that the gate never reads.

So the install is a no-op for enforcement, and it is silent about it: the
edited enforcer is verified by the test suite (which reads the worktree source)
while the running gate still executes the old code. Verified 2026-08-03 by
comparing the materialized copy against both sources — it matched the main
checkout byte for byte.

So an enforcer fix is two separate steps in two different directories:

- edit the enforcer **in your worktree**, so the change ships in the PR;
- after it merges, run `uap policy install <slug>` **from the main checkout** to
  refresh the runtime copy.

Note that `enforcement-self-protect` blocks agent writes to `src/policies/**`
outright, with no model-reachable bypass. An agent cannot make either change —
enforcer edits are an operator action by design.

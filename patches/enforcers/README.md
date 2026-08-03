# Enforcer fixes — operator apply required

`enforcement-self-protect` protects `src/policies/**` against agent Edit/Write
with **no model-reachable bypass**, which is correct: an agent that can rewrite
its own gates has no gates. The consequence is that a *broken* enforcer also
cannot be repaired by an agent — the fix has to come from the operator, out of
band. That is what this directory is for.

These three changes were authored on branch `feature/160-plan-gate-writers`
after the plan-time gates blocked an ordinary planning session outright.

## Apply

From the repo root, in a normal terminal (not through the agent):

```bash
# 1. Put the fixed source in place
cp patches/enforcers/codebase_read_before_plan.py src/policies/enforcers/
cp patches/enforcers/memory_before_plan.py        src/policies/enforcers/
git apply patches/enforcers/workdir_scope.patch

# 2. REQUIRED — re-materialize the executable copies.
#    The gate does NOT run src/policies/enforcers/*.py. It runs
#    .policy-tools/<policyId>_<toolName>.py, a separate copy written by
#    PolicyToolRegistry.storeToolCode() and refreshed only by
#    autoAttachEnforcer(), which runs from `uap policy install|select`.
#    Skip this and the gate keeps executing the OLD code while the source
#    looks fixed.
uap policy install codebase-read-before-plan
uap policy install memory-before-plan
uap policy install workdir-scope

# 3. Verify the executable copy actually changed
grep -l writer_installed .policy-tools/*codebase_read_before_plan.py
grep -l "claude/plans" .policy-tools/*workdir_scope.py
```

Then delete this directory — it exists only to carry the change across the
self-protect boundary.

## What each fixes

| File | Bug | Fix |
|---|---|---|
| `codebase_read_before_plan.py` | Reads `.uap/read_log.state`, which **no hook wrote** — the settings matcher was never added. Entries aged past the 30-min window and the gate refused every `ExitPlanMode` with a remedy ("read the codebase first") that could not clear it. | Degrade to advisory when the writer hook is absent, probed per platform (`.claude`, `.factory`, `.cursor`, …) rather than under `.claude/` only. The writer itself ships on the same branch. |
| `memory_before_plan.py` | Read only `repo_root()`'s `short_term.db`. `uap memory query` writes to the CWD's DB, which inside a worktree is the *worktree's* — so the required query, run where the worktree policy mandates, produced evidence the gate never saw. | Check `worktree_root()` then `repo_root()`. Same `repo_root()`-vs-`worktree_root()` bug already fixed in `expert-review-required` and `local-build-before-push`. |
| `workdir_scope.py` | `~/.claude/plans` is not in the allow-list, so the agent cannot write the plan file the harness assigned it. The documented override is matched by self-protect's `BYPASS_PATTERNS`, leaving no in-session route. | Add `~/.claude/plans`, exactly as `~/.claude/projects` was added after it silently broke memory recording. |

## Follow-ups this branch does NOT fix

**1. `self-protect` reports "not registered/active" and fails closed on the
whole enforcement surface — from the main checkout as well as from a worktree.**

The cause is not an unpopulated policy DB (both DBs are populated: 59 rows in
the main checkout, 62 in the worktree). It is that `uap-policy-gate.sh` sets its
`sec_enforcer_ran` flag only for policies returned by an **INNER JOIN** of
`policies` against `executable_tools`, and the self-protect policy has **zero
rows in `executable_tools`** in both DBs. It is therefore never in the result
set, the flag never gets set, and the gate fails closed. Seeding the DB or
re-rooting the lookup would not change that; the missing `executable_tools`
linkage is the thing to repair (likely via `autoAttachEnforcer` for that slug).

Related: the worktree DB carries both `Enforcement Self Protect` and
`Enforcement Self-Protect` as separate active rows — a duplicate of the kind
`uap policy dedupe` exists to clean up.

**2. The fail-open in `codebase_read_before_plan.py` is self-triggerable.**
Deleting `.claude/hooks/post-tool-use-read.sh` is blocked by no gate, and that
deletion flips this enforcer to advisory. That is a real weakening versus a gate
that always blocks — but the status quo it replaces is a gate that can never
pass, which is not a security property either. The durable fix is to add the
writer hook paths to `enforcement_self_protect.py`'s `PROTECTED_MARKERS`, so
removing the writer needs the same operator override as weakening any other
enforcer. That is itself a `src/policies/**` edit, so it belongs in the same
out-of-band pass as the files here.

**3. Evidence is unauthenticated.** Both gates treat "a row/line exists" as
proof a command ran; an agent with Bash can write either directly. This predates
the branch and is unchanged by it — worth a ticket, and any hardening should
cover both gates together.

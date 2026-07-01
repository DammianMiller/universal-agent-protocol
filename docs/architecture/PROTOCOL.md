# The UAP Protocol

`v1.91.0`

> **🏭 Where this fits:** Cross-cutting (the factory rulebook) — with no shared
> contract, each station's rules are guesswork and your agent slips broken work
> past whichever gate it doesn't recognize. **What it delivers:** the normative
> hook-and-gate contract that makes every station on the
> [delivery pipeline](../guides/DELIVERY_PIPELINE.md) enforceable and portable —
> the same rules apply whichever harness runs the line.

This document specifies the **Universal Agent Protocol** itself: the contract
between an AI agent harness and the UAP layer beneath it. It is normative —
where it says *MUST* / *SHOULD* / *MAY*, those carry their usual meaning. For an
architectural tour of the components that implement this contract, see
[OVERVIEW.md](OVERVIEW.md).

UAP is not a wire protocol. It is a **convention enforced by hooks**: a small
set of interception points the harness exposes, a defined hook lifecycle, an
agent decision loop, and a set of gates that block work which violates the
contract. Any harness that can run a hook before tool execution can host UAP.

Read the sections below as the rules posted at each station on the floor:
session start feeds the **intake** station, the pre-tool-use gates guard
**isolation** and **build**, the decision loop threads **intake → build →
feedback**, the worktree convention is the **isolation** station itself, and the
completion gates are the **QC/verify** station that stops "done"-on-broken-code.

---

## 1. The harness ↔ UAP contract

A conforming harness MUST provide UAP with:

1. **A session-start interception point** — a place to run a script when an
   agent session begins, whose stdout is injected into the agent's context.
2. **A pre-tool-use interception point** — a place to run a script *before*
   each tool call, where a non-zero exit (specifically **exit code 2**) aborts
   the call.

UAP, in return, guarantees:

- Memory injection is **advisory and fail-open** — if hydration fails, the
  session proceeds without it. It never blocks an agent.
- Policy enforcement is **fail-closed for REQUIRED policies** — a REQUIRED
  violation blocks the call. RECOMMENDED / OPTIONAL policies only log.
- Tool output routed through the MCP Router is **compressed, not altered in
  meaning** — the model receives a faithful, smaller view of the same result.

### Supported interception points

| Harness | Session start | Pre-tool-use |
|---------|---------------|--------------|
| Claude Code / VSCode | `SessionStart` | `PreToolUse` |
| Factory | `SessionStart` | `PreToolUse` |
| Cursor | hooks.json | `preToolUse` |
| OpenCode | plugin | `tool.execute.before` |
| Codex | AGENTS.md / MCP | gating via UAP MCP `execute_tool` |
| Hermes | — | `pre_tool_call` |

Hook scripts are generated and installed by `uap hooks install`
(`src/cli/hooks.ts`) from `templates/hooks/`. Verify coverage with
`uap hooks doctor`.

---

## 2. Hook lifecycle

### 2.1 Session start

The **intake station.** On session start the harness runs the session-start
hook, which MUST:

1. **Inject memory.** Query the short-term store (last-24h top memories plus
   open "session" loops of type action/goal/decision with importance ≥ 7) and
   emit it wrapped in a `<uap-context>` block on stdout. The harness places
   this in the agent's context.
2. **Clean stale state.** Deregister dead agents and release abandoned work
   claims so coordination state stays accurate.

The hook is **self-healing and fail-open**: it auto-creates missing
coordination/memory DBs and never exits non-zero. Its output is advisory
context, not a gate.

### 2.2 Pre-tool-use

The **isolation and build gates.** Before each tool call the harness runs the
pre-tool-use hook, which runs the relevant gates for that tool. Conceptually:

```
pre-tool-use(tool, args):
    if tool in {Edit, Write, MultiEdit}:
        run worktree gate            # path MUST be under .worktrees/
    if tool == Bash:
        run dangerous-command guard  # block terraform apply, force-push, ...
    run policy gate (DB-driven)      # REQUIRED policies for this tool
    if any gate denies:
        exit 2                       # harness ABORTS the call
    else:
        allow                        # call proceeds (optionally via MCP Router)
```

A gate verdict is binary — **allow** or **deny**. There is no "modify" verdict.
A denied call returns **exit code 2** (shell enforcers) or throws
`PolicyViolationError` (in-process MCP gate). Post-tool-use hooks MAY run a
build gate or backup reminder; pre/post-compact hooks preserve protocol context
across context compaction; the stop hook runs a completion checklist.

---

## 3. Agent decision loop

The belt path itself: intake pulls context in, act builds, and feedback carries
lessons back out. A conforming agent SHOULD execute each task through this loop.
The TypeScript implementation lives in `src/memory/dynamic-retrieval.ts` (query)
and the short-term store / consolidator (record, promote).

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
   ┌─────────┐   ┌─────────┐   ┌──────┐   ┌────────┐   ┌─────────┐
   │  READ   │──▶│  QUERY  │──▶│ ACT  │──▶│ RECORD │──▶│ PROMOTE │
   │ short-  │   │ long-   │   │ via  │   │ to     │   │ lessons │
   │ term    │   │ term    │   │ tool │   │ short- │   │ to long-│
   │ memory  │   │ (semant)│   │      │   │ term   │   │ term    │
   └─────────┘   └─────────┘   └──────┘   └────────┘   └────┬────┘
                                                            │ next task
                                                            ▼
```

1. **READ** — read short-term memory for recent context (`uap memory query`).
2. **QUERY** — semantic search of long-term memory for related learnings.
3. **ACT** — classify the task, then execute via the appropriate tool
   (Edit / Write / Bash / a routed MCP tool / `uap deliver`).
4. **RECORD** — write observations to short-term memory.
5. **PROMOTE** — promote significant learnings to long-term memory, **through
   the write-gate** (which scores and rejects low-quality memories).

A learning is significant enough to PROMOTE when it changes future behavior:
an important decision with rationale (importance ≥ 7), a pattern that prevents a
recurring error, or a configuration choice with context. Trivial observations,
transient debugging state, and secrets MUST NOT be promoted.

---

## 4. Worktree convention

The **isolation station.** All file edits MUST happen inside a git worktree
under `.worktrees/NNN-<slug>/`. Edits to the project root are blocked by the
worktree gate (`worktree_required.py`) — this is what keeps your agent off
`master` and out of another agent's lane.

```bash
uap worktree ensure --strict     # verify you are inside a worktree (exit 0)
uap worktree create <slug>       # auto-numbered branch + worktree if not
# ... edit, stage, commit inside the worktree ...
uap worktree pr                  # open a PR from the worktree branch → master
uap worktree finish              # finish + clean up after merge
```

Rules:

- All edit paths MUST be under `.worktrees/NNN-<slug>/`.
- Version bumps MUST happen on the feature branch, never on `master`.
- PRs open from the worktree branch against `master`.
- This applies to **every** file type — `.ts`, `.md`, `.json`, `.sh`,
  configs, tests, docs. There is no exemption for "small" or "docs-only"
  changes.

**Read-only tasks** (analysis, diagnostics, queries) do NOT require a worktree.

---

## 5. Completion gates

The **QC/verify station — the one everyone skips.** Claiming a code change is
DONE is prohibited until all gates pass; this is where "the agent said done on a
red build" gets caught. The gates are decomposed across policy enforcers and the
`review`-stage policy logic in `policy-gate.ts` (auto-forced on completion /
merge / deploy operations):

| Gate | Enforcer / mechanism | Requirement |
|------|----------------------|-------------|
| Tests | `test_gate.py` + `npm test` | new tests cover changed behavior; suite passes |
| Build | post-tool-use build gate + `npm run build` | compiles with zero errors |
| Type-check | `tsc --noEmit` | passes cleanly |
| Task discipline | `task_required.py` | a UAP task is `in_progress` before mutating work |
| Expert review | `expert_review_required.py` | parallel expert review precedes ship |
| Schema diff | `schema_diff_gate.py` | schema/contract changes pass `uap schema-diff` |
| Memory lesson | `session_memory_write.py` | code-changing sessions write a lesson |
| Version bump | `npm run version:patch/minor/major` | bumped on the feature branch |

The `uap deliver` convergence loop is the programmatic embodiment of these
gates: its verifier ladder runs build → typecheck → test → lint as real
commands and iterates the model until every *required* gate passes. See
[OVERVIEW.md](OVERVIEW.md#how-uap-deliver-orchestrates).

Completion gates MUST be verified before claiming done. RECOMMENDED practice is
to verify at least three points: before changes (baseline), after changes, and
after fixes.

---

## 6. Conformance summary

A harness + agent pair conforms to the UAP protocol when:

- [ ] Session-start hook injects `<uap-context>` memory and is fail-open.
- [ ] Pre-tool-use hook runs worktree, command-safety, and policy gates.
- [ ] A REQUIRED policy denial aborts the tool call (exit 2).
- [ ] The agent follows the READ → QUERY → ACT → RECORD → PROMOTE loop.
- [ ] All edits occur inside `.worktrees/NNN-<slug>/`.
- [ ] Completion gates pass before any DONE claim.

Install and audit the full stack with:

```bash
uap setup           # init + memory + patterns + hooks + policies
uap hooks doctor    # audit policy-gate coverage across harnesses
uap compliance check
```

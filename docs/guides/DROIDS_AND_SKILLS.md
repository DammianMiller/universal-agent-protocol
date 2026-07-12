# Droids and Skills

> Applies to UAP **v1.93.1**

> **🏭 Where this fits:** PREP/ROUTING — this is the station where a
> generalist agent takes the wrong approach on specialist work: reviewing
> security like a linter, refactoring without an architect's eye. **What it
> delivers:** the right specialist station gets put in front of your model
> *before* it starts — a security auditor for auth work, a language expert for
> the language at hand — so the approach is right from the first line.

UAP ships two complementary extension mechanisms that decide *who* and *how* at
the prep stage of your [delivery pipeline](./DELIVERY_PIPELINE.md):

- **Droids** — markdown-defined specialist agents (a reviewer, a language
  expert, an architect). Each droid is a focused persona with its own tools and
  instructions.
- **Skills** — reusable workflows that any agent can load on demand (a coding
  protocol, a navigation technique, a memory operation).

Droids answer *"who should do this?"*; skills answer *"how is this done?"*. A
droid can pull in skills when a domain-specific workflow applies. Think of them
as swapping in the right specialist station for the job rather than sending
everything down one generalist line.

## What a droid is

A droid is a single markdown file under
[`.factory/droids/`](../../.factory/droids/) with YAML frontmatter followed by a
prompt body. The frontmatter declares the droid's identity, model, tools, and
optional coordination/skill metadata.

A minimal droid (the default scaffold from `uap droids add`):

```markdown
---
name: my-droid
description: Custom droid for my-droid
model: inherit
tools: ["Read", "LS", "Grep", "Glob"]
---

You are a specialized assistant for my-droid tasks.

Describe what this droid should do and how it should respond.
```

A real droid carries richer frontmatter — for example `security-auditor`:

```markdown
---
name: security-auditor
description: Proactive security analyst that reviews all code for vulnerabilities, secrets exposure, injection attacks, and security best practices.
model: inherit
coordination:
  channels: ["review", "broadcast"]
  claims: ["exclusive"]
  batches_deploy: true
skills:
  - sec-context-review
---
# Security Auditor

## Mission
...
```

Frontmatter fields used by UAP:

- `name` — **required**, unique across droids. Used to reference the droid.
- `description` — **required**, at least 5 characters. Shown in listings and
  used by the expert router for capability matching.
- `model` — `inherit` (use the caller's routed model) or a specific model id.
- `tools` — the tool allowlist the droid may use.
- `coordination` — optional; declares channels, claim semantics
  (`exclusive` / `shared`), and deploy batching for multi-droid runs.
- `skills` — optional; skills the droid loads for its domain.

Droids are invoked as subagents, e.g.
`Task(subagent_type: "security-auditor", prompt: "...")`.

## The droid library

UAP ships **38 droids** in `.factory/droids/`. They cluster into a few
categories:

- **Language experts** — `python-pro`, `typescript-node-expert`,
  `javascript-pro`, `go-pro`, `rust-pro`
- **Reviewers** — `code-quality-reviewer`, `code-quality-guardian`,
  `security-code-reviewer`, `performance-reviewer`, `test-coverage-reviewer`,
  `documentation-accuracy-reviewer`, `architect-reviewer`
- **Architects & planners** — `strategic-architect`, `tactical-architect`,
  `implementation-planner`, `product-strategist`, `ideation-expert`
- **Security & compliance** — `security-auditor`, `compliance-officer`,
  `dependency-auditor`
- **Quality & testing** — `qa-expert`, `test-strategist`, `test-plan-writer`,
  `refactoring-specialist`, `debug-expert`
- **Performance & cost** — `performance-optimizer`, `cost-engineer`,
  `harness-optimizer`, `terminal-bench-optimizer`
- **Ops & infrastructure** — `sysadmin-expert`, `observability-engineer`,
  `incident-responder`, `release-manager`
- **Domain specialists** — `api-designer`, `cli-design-expert`,
  `accessibility-tester`, `documentation-expert`, `ml-training-expert`

Run `uap droids list` to see the live set across all sources.

## `uap droids` CLI

Defined in `src/cli/droids.ts` and registered in `src/bin/cli.ts`.

```bash
uap droids list                       # list droids from all known locations + built-in templates
uap droids add <name>                 # scaffold a new droid in .factory/droids/
uap droids add <name> -t <template>   # scaffold from a built-in template
uap droids import <path>              # import .md droids from another directory
uap droids validate                  # validate frontmatter + capability-router coverage
uap droids validate -q               # quiet mode: exit code only
```

`uap droids list` scans, in order:

- `.factory/droids` (project)
- `.claude/agents` (Claude Code)
- `.opencode/agent` (OpenCode)
- `~/.factory/droids` (personal)

Built-in templates available to `uap droids add -t`: `code-reviewer`,
`security-reviewer`, `performance-reviewer`, `test-writer`.

`uap droids validate` parses every droid's frontmatter and reports errors for
missing/short descriptions, missing names, duplicate names, and invalid YAML.
It also cross-references the capability router so any droid the router expects
but that is missing on disk is flagged.

## The expert router

`uap expert-route` recommends an ordered **chain** of droids for a task,
grouped into phases (ideate → plan → design → implement → review → release). It
is backed by the `ExpertOrchestrator` (`src/coordination/expert-orchestrator.ts`).

```bash
uap expert-route "add OAuth2 login with JWT sessions"
uap expert-route "refactor the payment module" --files src/payments/*.ts
uap expert-route "harden the upload endpoint" --json
```

Output shows the matched capabilities, a confidence score, and for each step:
the phase, the droid, whether it runs in parallel, a rationale, and a historical
success rate (when available). `--files` scopes routing by the affected paths;
`--json` emits machine-readable output (also used automatically when stdout is
not a TTY).

## Skills

A skill is a reusable workflow. Skills live in directories under
[`.factory/skills/`](../../.factory/skills/), each containing a `SKILL.md` file
with frontmatter (`name`, `version`, `compatibility`) and the workflow body.

UAP ships **36 skills** in `.factory/skills/`, including:

- **Coordination & workflow** — `uap-coordination`, `uap-tasks`,
  `uap-worktree`, `worktree-workflow`, `parallel-expert-review`, `batch-review`
- **Memory & context** — `uap-memory`, `memory-management`,
  `scripts-preload-memory`, `session-context-preservation-droid`
- **Navigation & analysis** — `codebase-navigator`, `git-forensics`,
  `uap-patterns`, `compression`
- **Engineering** — `typescript-node-expert`, `polyglot`, `cli-design-expert`,
  `llama-cpp-worker`, `infra-worker`, `service-config`
- **Iteration & benchmarking** — `near-miss`, `near-miss-iteration`,
  `adversarial`, `terminal-bench`, `terminal-bench-strategies`
- **Hooks** — `hooks-session-start`, `hooks-pre-compact`, `scripts-tool-router`

### `uap skill` CLI

Defined in `src/cli/skill.ts`.

```bash
uap skill list                 # list available skills (with source tag)
uap skill list -c <category>   # filter by path/category substring
uap skill list --json          # machine-readable listing
uap skill load <name>          # print a skill's full content for the session
uap skill load <name> -c <cat> # scope discovery by category
```

Skills are discovered from three roots, in order: `skills/` (project),
`.factory/skills/`, and `.claude/skills/`. A directory with a `SKILL.md` is
treated as a skill, as is any top-level `.md` file in those roots. `load`
matches names case-insensitively.

## Adding a custom droid

```bash
# 1. Scaffold (optionally from a template)
uap droids add my-reviewer -t code-reviewer

# 2. Edit .factory/droids/my-reviewer.md
#    - set a clear, >= 5-char description (used by the expert router)
#    - adjust the tools allowlist
#    - write the prompt body / mission

# 3. Validate before relying on it
uap droids validate
```

To bring droids in from another project or platform, drop the `.md` files in a
folder and run `uap droids import <path>` (existing files are skipped, not
overwritten).

## See also

- [Multi-Model Routing](./MULTI_MODEL.md) — the models that droids and skills
  run on, and how tasks are routed to them.

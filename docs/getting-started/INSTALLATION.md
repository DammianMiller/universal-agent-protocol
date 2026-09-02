# Installation

> **🏭 Where this fits:** Setting up the floor — before any station can run, UAP has to be installed and wired into your agent harness. **What it delivers:** one `npm install` + one `uap setup` and every station on the [delivery pipeline](../guides/DELIVERY_PIPELINE.md) is live in your project.

Welcome. The Universal Agent Protocol (UAP) is the discipline layer that turns
your AI agent into a reliable member of your software delivery line. Left to its
own devices an agent forgets what it learned yesterday, picks the wrong approach,
edits your main branch, writes plausible-but-wrong code, and cheerfully declares
"done" on something that never actually ran. UAP puts a station at each of those
break points so the work that comes off the line is trustworthy.

It ships as a single npm package (`@miller-tech/uap`, v1.224.0) that installs the
`uap` CLI. This page gets it onto your machine and wired into your project.

## Prerequisites

You don't need all of these to start — UAP works with just Node, and turns on
more stations as you provide the pieces.

| Requirement | Needed for | Notes |
| --- | --- | --- |
| **Node.js >= 18** | Everything | The CLI is published as ESM and requires Node 18 or newer. |
| **git** | Worktree workflow, memory prepopulation from history | Any recent git. |
| **Docker** | Local Qdrant (semantic memory tier) | `uap setup` starts a Qdrant container via docker-compose. Optional — memory degrades gracefully without it. |
| **Python 3** | Pattern RAG indexing & embeddings | Optional. `uap setup` creates a virtualenv and installs the pattern indexing dependencies. |
| **A local OpenAI-compatible model** | `uap deliver`, multi-model routing | Optional. Points at an OpenAI-compatible `/v1` endpoint (default `http://localhost:4000/v1`). |

If you skip Docker, Python, or a local model, those steps are simply skipped and
the matching features (semantic recall, pattern RAG, the convergence harness) sit
dormant until you provide them later. Nothing breaks — you just start with fewer
stations lit up.

## Install

Install the CLI globally:

```bash
npm install -g @miller-tech/uap
```

### Verify the install

```bash
uap --version
```

This prints the installed package version (e.g. `1.93.1`).

## One-command setup

From the root of the project you want to wire up, run:

```bash
uap setup
```

`uap setup` is a **friendly, arrow-key guided wizard by default** (powered by
@clack/prompts). It walks you through the whole delivery line, one station at a
time — memory tiers so your agent remembers, patterns and the policy engine so it
follows your rules, your model provider/profile, harness hooks, the browser
dashboard, and the newer stations too: **recipes and the escalation judge,
delivery gates, model-slot concurrency, cross-agent collaboration, DESIGN.md, and
the reactor**. Each prompt comes with a **smart default inferred from your
environment** (Docker → offer Qdrant; a detected local model endpoint →
preselect the local provider/profile), so you can usually just press Enter to
accept the recommended path.

When it finishes, setup writes your `.uap.json` and a `.uap/proxy.env` (the proxy
auto-loads that env file, so your model wiring is picked up automatically). On a
non-TTY/CI run, or with `--non-interactive`/`-y`, it runs the same flow
non-interactively with defaults so pipelines never hang on a prompt.

Before it changes anything, setup **backs up your existing agent instruction
files** (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …, plus `.uap.json`) to
`.uap-backups/<date>/`, and offers to **extract your unique custom instructions
into reusable UAP policies and skills** (see below). It then chains the
individual commands so the whole system "just works", running these steps:

0. **Self-update the CLI** — before anything else, `setup` checks npm and
   **auto-updates the globally-installed `uap` to the latest published version**
   if it is behind, so every setup runs against current behaviour. It is
   non-fatal and self-limiting: only a real global install is updated (a source
   checkout or a local/monorepo dependency is left alone), it is downgrade-proof,
   and it is **skipped in CI** for reproducibility (`UAP_SELF_UPDATE=1` forces
   it). The update applies on the next `uap` invocation. Disable with
   `--no-self-update` or `UAP_NO_SELF_UPDATE=1`.
1. **Initialize the project** (`uap init` under the hood) — creates `.uap.json`,
   the `agents/data/memory` directory structure, the short-term memory database,
   a `CLAUDE.md` (or `AGENT.md`), the worktree workflow scaffold, and the Python
   pattern scripts.
2. **Start Qdrant** — uses the serverless Qdrant manager if one is configured in
   `.uap.json`, otherwise starts a Qdrant container via docker-compose. If Docker
   is unavailable this step warns and continues.
3. **Wait for the Qdrant healthcheck** (up to 15s). If Qdrant is not reachable,
   pattern indexing is skipped.
4. **Start background memory consolidation** and **auto-promote** high-quality
   daily-log entries into longer-lived memory tiers (non-fatal if unavailable).
5. **Create the Python virtualenv** for pattern RAG if `init` did not already do
   so. Skipped with a warning when Python 3 is not on the system.
6. **Index patterns into Qdrant** — only when both Qdrant and Python are ready.
7. **Configure the MCP Router** for all detected AI harnesses.
8. **Install policy-gate and lifecycle hooks** for the project's platforms (run
   `uap hooks doctor` afterward to verify coverage).
9. **Print a setup summary** showing which steps succeeded and which optional
   steps were skipped.

### Useful `uap setup` flags

```bash
uap setup                    # guided arrow-key wizard (default)
uap setup --non-interactive  # scripted run with defaults (also -y); auto on CI/non-TTY
uap setup --no-backup        # do not back up instruction files first
uap setup --no-extract       # skip custom-content extraction
uap setup --extract-auto     # (scripted mode) auto-extract instead of report-only
uap setup --no-memory        # init only, skip Qdrant/memory services
uap setup --no-patterns      # skip pattern RAG setup and indexing
uap setup --no-self-update   # do not auto-update the global CLI
uap setup -d <path>          # set up a project directory other than the cwd
```

### Backup & custom-content extraction

Every `uap setup` first copies your agent instruction files — `CLAUDE.md`,
`AGENTS.md`, `AGENT.md`, `GEMINI.md`, `.cursorrules`, `.clinerules`,
`.windsurfrules`, and `.uap.json` — to `.uap-backups/<date>/` (idempotent, gitignored)
so a run is always reversible. Disable with `--no-backup`.

It then detects **non-standard sections** in those files (anything beyond the UAP
scaffolding) and offers to promote each into a reusable UAP artifact:

- imperative rules/gates (e.g. "MUST never commit secrets") → a **policy** under
  `policies/<slug>.md` (registered with the policy engine);
- workflows/how-tos (e.g. "How to deploy") → a **skill** under
  `skills/<name>/SKILL.md`.

In the wizard you confirm/redirect each section; in scripted mode it is
report-only unless you pass `--extract-auto`. Extraction is deterministic (no
model calls), idempotent (it won't re-extract a section it already promoted), and
never overwrites existing files. See **[Policies](../guides/POLICIES.md)** and
`uap skill list`.

### Init only

If you only want the project scaffold (config, directories, `CLAUDE.md`) without
starting services, run:

```bash
uap init
```

`uap init` accepts `--web` (generate `AGENT.md` for web platforms),
`--no-memory`, `--no-worktrees`, `--patterns` / `--no-patterns`, and `-f, --force`
to overwrite existing configuration.

## Installing harness hooks

UAP works with nine AI coding harnesses: **Claude Code, Factory, Cursor, VSCode,
OpenCode, Codex, ForgeCode, Oh-My-Pi, and Hermes**. `uap setup` installs hooks
for the platforms it finds in your project automatically, but you can install or
re-install them by hand any time.

Install hooks for every detected harness:

```bash
uap hooks install
```

Install for a single harness with `-t` / `--target` (or the `-p` / `--platform`
alias). Valid targets are `claude`, `factory`, `cursor`, `vscode`, `opencode`,
`codex`, `forgecode`, `omp`, and `hermes`:

```bash
uap hooks install -t claude
uap hooks install -t hermes   # Hermes is global, so it is opt-in
```

Check installation status and audit policy-gate coverage:

```bash
uap hooks status     # show what is installed, per platform
uap hooks doctor     # audit policy-gate coverage (exits non-zero on gaps)
```

## Next steps

- [Quickstart](./QUICKSTART.md) — a 5-minute path from setup to your first
  delivered task.
- [Configuration](./CONFIGURATION.md) — `.uap.json` options, environment
  variables, Qdrant, and model profiles.

# Installation

The Universal Agent Protocol (UAP) is an autonomous AI agent memory system with
CLAUDE.md protocol enforcement. It ships as a single npm package
(`@miller-tech/uap`, v1.40.0) that installs the `uap` CLI.

## Prerequisites

| Requirement | Needed for | Notes |
| --- | --- | --- |
| **Node.js >= 18** | Everything | The CLI is published as ESM and requires Node 18 or newer. |
| **git** | Worktree workflow, memory prepopulation from history | Any recent git. |
| **Docker** | Local Qdrant (semantic memory tier) | `uap setup` starts a Qdrant container via docker-compose. Optional — memory degrades gracefully without it. |
| **Python 3** | Pattern RAG indexing & embeddings | Optional. `uap setup` creates a virtualenv and installs the pattern indexing dependencies. |
| **A local OpenAI-compatible model** | `uap deliver`, multi-model routing | Optional. Points at an OpenAI-compatible `/v1` endpoint (default `http://localhost:4000/v1`). |

UAP works without Docker, Python, or a local model — those steps are skipped and
the corresponding features (semantic recall, pattern RAG, the convergence
harness) are simply unavailable until you provide them.

## Install

Install the CLI globally:

```bash
npm install -g @miller-tech/uap
```

### Verify the install

```bash
uap --version
```

This prints the installed package version (e.g. `1.40.0`).

## One-command setup

From the root of the project you want to wire up, run:

```bash
uap setup
```

`uap setup` chains the individual commands so the whole system "just works". It
runs the following steps in order:

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
uap setup --no-memory      # init only, skip Qdrant/memory services
uap setup --no-patterns    # skip pattern RAG setup and indexing
uap setup -i               # interactive wizard with feature toggles
uap setup --verbose        # detailed output
uap setup -d <path>        # set up a project directory other than the cwd
```

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

UAP supports nine AI coding harnesses: **Claude Code, Factory, Cursor, VSCode,
OpenCode, Codex, ForgeCode, Oh-My-Pi, and Hermes**. `uap setup` installs hooks
for the project's platforms automatically, but you can install or re-install them
manually.

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

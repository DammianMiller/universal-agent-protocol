# Quickstart

Get from a clean checkout to your first delivered task in about five minutes.
This assumes you have already installed the CLI — see
[Installation](./INSTALLATION.md) if not.

## 1. Set up your project (~1 min)

From the root of your project:

```bash
uap setup
```

This initializes `.uap.json`, the memory directories and database, generates
`CLAUDE.md`, starts Qdrant (if Docker is available), wires the MCP Router, and
installs the harness hooks. It finishes with a summary showing which steps
succeeded.

Confirm memory is healthy:

```bash
uap memory status
```

You should see the short-term store initialized and, if Qdrant came up, the
long-term endpoint reported at `http://localhost:6333`.

## 2. Store and query a memory (~1 min)

Write a learning into long-term memory:

```bash
uap memory store "API keys are loaded from the QDRANT_API_KEY env var" -t config,memory -i 7
```

`-t` adds comma-separated tags and `-i` sets the importance score (1-10). The
store applies a quality write gate by default; pass `-f` to bypass it.

Now query it back semantically:

```bash
uap memory query "where do api keys come from"
```

The query runs a semantic search against the long-term store and prints the
matching entries with their similarity scores. Tune results with
`-n <limit>` and `-t <threshold>` (minimum similarity, default `0.35`).

## 3. Run `uap deliver` on a small task (~2 min)

`uap deliver` is the convergence harness: it iterates a model against your
project's **real completion gates** (build, typecheck, test, lint) until every
required gate passes or the turn budget is exhausted.

First do a dry run to see the detected gates and plan without calling a model:

```bash
uap deliver "fix the failing test in src/utils/dates" --dry-run
```

The dry run prints the project root, the model preset, the turn budget, and the
list of gates it discovered from your `package.json` scripts. If no verifiable
gates are detected, deliver tells you so instead of running.

When the plan looks right, run it for real:

```bash
uap deliver "fix the failing test in src/utils/dates"
```

Notes on behaviour:

- The default model preset is `qwen35-a3b` (override with `-m <preset>` or the
  `UAP_DELIVER_MODEL` env var).
- Task-aware auto-optimization is on by default — deliver classifies the task and
  enables matching convergence aids automatically. Disable with `--no-auto`.
- Loop-until-delivered is on by default: deliver keeps iterating past
  `--max-turns` up to a ceiling (default 30, set with `--ceiling`), stopping
  early on stagnation. Disable with `--no-until-delivered`.
- Pre-existing test files are protected from modification by default; allow edits
  with `--no-protect-tests`.
- Add `--json` for machine-readable output, or `--optimize` to enable every
  convergence aid (exploration, critic, practices, escalation, ideation, HALO,
  coordination).

## 4. View the dashboard (~1 min)

UAP ships a rich terminal dashboard. View the full system overview:

```bash
uap dashboard overview
```

Other views are available as subcommands — for example:

```bash
uap dashboard memory     # memory health, capacity, and layer architecture
uap dashboard tasks      # task breakdown, progress bars, hierarchy trees
uap dashboard models     # multi-model routing analytics
```

Prefer a browser? Start the web dashboard with live updates:

```bash
uap dashboard serve            # http://localhost:3847
uap dashboard serve -p 4000    # custom port
```

## Where to go next

- [Configuration](./CONFIGURATION.md) — `.uap.json`, environment variables,
  Qdrant, and model profiles.
- [Installation](./INSTALLATION.md) — per-harness hook installation and
  prerequisites.

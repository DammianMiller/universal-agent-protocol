# Configuration

> **🏭 Where this fits:** The control panel for the whole line — every station's knobs in one place. **What it delivers:** sensible defaults out of the box (via `uap setup`), and precise control when you want to tune how your [delivery pipeline](../guides/DELIVERY_PIPELINE.md) behaves.

Most of the time you won't touch any of this — `uap init` / `uap setup` write a
working `.uap.json` and a `.uap/proxy.env` for you, and the wizard picks sensible
defaults for every station on the line. But when you're ready to tune how your
delivery line behaves, this is the page. UAP is configured through the
project-level `.uap.json` file plus a set of environment variables, and every
option below actually exists in the code, so you can adjust it by hand with
confidence. The proxy auto-loads `.uap/proxy.env`, so model wiring you set there
is picked up automatically.

## Project config: `.uap.json`

`.uap.json` lives at the project root and is validated against a strict schema —
unknown keys and bad types are rejected, so a typo fails loudly instead of
silently doing the wrong thing. Every section is optional except `project`;
defaults are applied for anything you omit.

```json
{
  "version": "1.0.0",
  "project": {
    "name": "my-project",
    "description": "Optional description",
    "defaultBranch": "main"
  },
  "platforms": {
    "claudeCode": { "enabled": true },
    "factory": { "enabled": true },
    "vscode": { "enabled": true },
    "opencode": { "enabled": true },
    "codex": { "enabled": true }
  },
  "memory": {
    "shortTerm": { "enabled": true, "path": "./agents/data/memory/short_term.db", "maxEntries": 50 },
    "longTerm": { "enabled": true, "provider": "qdrant", "collection": "agent_memory", "embeddingModel": "all-MiniLM-L6-v2" },
    "patternRag": { "enabled": false, "collection": "agent_patterns", "topK": 2, "scoreThreshold": 0.35 }
  },
  "worktrees": { "enabled": true, "directory": ".worktrees", "branchPrefix": "feature/", "autoCleanup": true }
}
```

### Top-level sections

| Key | Purpose |
| --- | --- |
| `project` | **Required.** `name`, optional `description`, `defaultBranch` (default `main`). |
| `platforms` | Per-harness toggles and memory-budget overrides: `claudeCode`, `factory`, `vscode`, `opencode`, `codex`. Each accepts `enabled`, `shortTermMax`, `searchResults`, `sessionMax`, `patternRag`. |
| `memory` | Memory tiers: `shortTerm`, `longTerm`, `patternRag` (see below). |
| `worktrees` | `enabled`, `directory` (default `.worktrees`), `branchPrefix` (default `feature/`), `autoCleanup`. |
| `droids` | Array of custom droid definitions (`name`, `template`, `description`, `model`, `tools`). |
| `commands` | Array of custom command definitions (`name`, `template`, `description`, `argumentHint`). |
| `template` | CLAUDE.md template selection: `extends` and per-section `sections` toggles. |
| `costOptimization` | Token budgets, embedding batching, and LLM call reduction. |
| `timeOptimization` | Deploy batch windows, parallel execution limits, service pre-warming. |
| `multiModel` | Multi-model routing (see [Model profiles](#model-profiles)). |
| `agentExecution` | Benchmark-proven agent execution feature flags (see below). |
| `patternRL` | Pattern reinforcement learning: `enabled`, `dbPath`. |

### Memory tiers

`memory.shortTerm`:

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | |
| `path` | `./agents/data/memory/short_term.db` | SQLite database path. |
| `webDatabase` | — | IndexedDB name for web platforms. |
| `maxEntries` | `50` | |

`memory.longTerm` (the semantic tier):

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | |
| `provider` | `qdrant` | One of `qdrant`, `github`, `qdrant-cloud`, `none`. |
| `endpoint` | — | Qdrant endpoint; falls back to `localhost:6333`. |
| `collection` | `agent_memory` | |
| `embeddingModel` | `all-MiniLM-L6-v2` | |
| `github` | — | GitHub-backed memory: `repo`, `token`, `path`, `branch`. |
| `qdrantCloud` | — | Qdrant Cloud: `url`, `apiKey`, `collection`. |
| `serverless` | — | Serverless Qdrant (see below). |

`memory.patternRag` (on-demand pattern retrieval): `enabled`, `collection`
(`agent_patterns`), `embeddingModel` (`all-MiniLM-L6-v2`), `vectorSize` (`384`),
`scoreThreshold` (`0.35`), `topK` (`2`), and the `indexScript` / `queryScript`
paths.

### Qdrant configuration

The default local provider talks to Qdrant at `http://localhost:6333` — the
endpoint `uap setup` starts via docker-compose. Override it with
`memory.longTerm.endpoint`.

For managed Qdrant, set `memory.longTerm.provider` to `qdrant-cloud` and fill in
`memory.longTerm.qdrantCloud`:

```json
{
  "memory": {
    "longTerm": {
      "provider": "qdrant-cloud",
      "qdrantCloud": {
        "enabled": true,
        "url": "https://xyz.qdrant.io",
        "apiKey": "...",
        "collection": "agent_memory"
      }
    }
  }
}
```

`url` and `apiKey` fall back to the `QDRANT_URL` and `QDRANT_API_KEY` environment
variables when omitted, so you can keep secrets out of the config file.

For cost-sensitive setups, `memory.longTerm.serverless` enables a lazy-start
local instance or a cloud-serverless backend:

```json
{
  "memory": {
    "longTerm": {
      "provider": "serverless",
      "serverless": {
        "enabled": true,
        "mode": "lazy-local",
        "lazyLocal": { "port": 6333, "autoStart": true, "autoStop": true, "idleTimeoutMs": 300000 }
      }
    }
  }
}
```

`mode` is one of `lazy-local`, `cloud-serverless`, or `hybrid`. Hybrid mode picks
local vs. cloud based on `NODE_ENV`, `UAP_ENV`, or auto-detection.

### Agent execution flags

`agentExecution` exposes benchmark-tuned feature flags for the delivery harness.
Defaults are the proven-effective subset; some flags are deliberately off because
they regressed small models. Notable fields:

| Field | Default | Notes |
| --- | --- | --- |
| `domainHints` | `true` | Domain-specific hints routed by task classification. |
| `lowTemperature` / `temperature` | `true` / `0.15` | Deterministic sampling. |
| `preExecutionHooks` | `true` | File backups and tool installs before the agent starts. |
| `webSearch` | `false` | Off by default; enable for larger (70B+) models. |
| `reflectionCheckpoints` | `false` | Harmful for small models. |
| `softBudget` / `hardBudget` | `35` / `50` | Tool-call budget thresholds. |

## Model profiles

UAP includes **7 execution profiles** — feature-flag presets tuned per model
family. They are auto-detected from the model id but can be forced via the
`UAP_MODEL_PROFILE` environment variable:

`small-moe`, `small-dense`, `medium`, `large`, `claude`, `gpt`, `gemini`.

Multi-model routing is configured under the `multiModel` section of `.uap.json`:

```json
{
  "multiModel": {
    "enabled": true,
    "models": ["opus-4.6", "qwen35-a3b"],
    "roles": {
      "planner": "opus-4.6",
      "executor": "qwen35-a3b",
      "fallback": "qwen35-a3b"
    }
  }
}
```

`models` may reference built-in presets or inline custom model definitions.
Built-in presets include `opus-4.6`, `sonnet-4.6`, `qwen35-a3b`, `gpt-5.4`, and
`gpt-5.3-codex`. Roles default to `opus-4.6` (planner) and `qwen35-a3b`
(executor/fallback). Inspect routing with `uap model` (status, route, plan,
compare, presets, select, export, health) and `uap dashboard models`.

## Environment variables

These are the environment variables read by the code. You'll usually leave them
alone — the wizard writes what's needed into `.uap/proxy.env` — but here's the
full set for when you want to override something.

### Memory & Qdrant

| Variable | Used for |
| --- | --- |
| `QDRANT_URL` | Qdrant endpoint for cloud/serverless backends (overridden by config when both are set). |
| `QDRANT_API_KEY` | Qdrant API key (fallback when not in config). |
| `UAP_EMBEDDING_ENDPOINT` | Embedding server endpoint for semantic memory. |

### Delivery harness (`uap deliver`)

| Variable | Used for |
| --- | --- |
| `UAP_DELIVER_MODEL` | Default model preset for `uap deliver` (fallback `qwen35-a3b`). |
| `UAP_ESCALATE_MODEL` | Stronger preset used by the escalation ladder. |
| `UAP_DELIVER_AUTO` | Set to `0` to disable task-aware auto-optimization. |
| `UAP_DELIVER_UNTIL_DELIVERED` | Set to `0` to disable loop-until-delivered. |
| `UAP_DELIVER_ACTIVE` | Set to `1` by the loop for its own subprocesses (policy enforcers detect it). |
| `UAP_DELIVER_SANDBOX` | Sandbox root that confines deliver's target directory (MCP tool). |

### Models & inference

| Variable | Used for |
| --- | --- |
| `UAP_MODEL_PROFILE` | Force an execution profile (otherwise auto-detected). |
| `UAP_LLM_SERVER` | LLM server base URL for tool-call tooling (default `http://127.0.0.1:4000`). |
| `UAP_INFERENCE_ENDPOINT` | Fallback OpenAI-compatible endpoint (default `http://localhost:4000/v1`). |

### Observability (HALO)

| Variable | Used for |
| --- | --- |
| `UAP_HALO_TRACE` | Set to `1` to enable HALO trace collection. |
| `UAP_HALO_TRACE_PATH` | Trace output file (default `.uap/halo/traces.jsonl`). |
| `UAP_HALO_PROJECT_ID` | HALO project identifier. |

### Concurrency & runtime

| Variable | Used for |
| --- | --- |
| `UAP_MAX_PARALLEL` | Override the auto-detected max parallelism (always wins). |
| `UAP_PARALLEL` | Set to `false` to disable parallel execution. |
| `UAP_LOG_LEVEL` | Log verbosity (e.g. `debug`, `warn`). |
| `UAP_AGENT_ID` | Stable agent identifier used by the coordination layer. |
| `NODE_ENV` / `UAP_ENV` | Environment detection for hybrid serverless mode (`UAP_ENV=production` selects the prod backend). |
| `HERMES_HOME` | Hermes config home (default `~/.hermes`). |

### Provider credentials

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FACTORY_API_KEY`, `DROID_API_KEY`, and
`GITHUB_TOKEN` are read when the corresponding provider or GitHub-backed memory
is configured.

## See also

- [Installation](./INSTALLATION.md)
- [Quickstart](./QUICKSTART.md)

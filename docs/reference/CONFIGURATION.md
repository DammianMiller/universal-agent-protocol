# Configuration Reference

> Universal Agent Protocol (UAP) v1.93.1

> **🏭 Where this fits:** Cross-cutting — the settings that tune every station.
> **What it delivers:** the dials that decide how your [delivery pipeline](../guides/DELIVERY_PIPELINE.md)
> runs — where memory lives, which model builds, how strict the gates are — so
> the line behaves the way your project needs.

Think of this as the machine's control settings: the values that tune each
station on the line. All configuration surfaces below are verified against
source. Only options that exist in code are documented here.

## Config files

| File | Owner / where read | Purpose |
|------|--------------------|---------|
| `.uap.json` | `src/utils/config-loader.ts` (searched up to 3 parent dirs for worktrees) | Central UAP config, validated by `AgentContextConfigSchema` (`src/types/config.ts`). |
| `.factory/patterns/index.json` | `src/coordination/pattern-router.ts` | Pattern catalogue / router source of truth. |
| `mcp.json` (platform path; `~/.factory/mcp.json` on Linux) | `src/cli/setup-mcp-router.ts`, `src/mcp-router/config/parser.ts` | MCP router server registration; supports `~`, `%APPDATA%`, `%USERPROFILE%`, `${VAR:-default}`, `$env:VAR` expansion. |
| `.codex/config.toml` | `src/cli/hooks.ts` | Codex CLI config + UAP MCP server section. |
| `.claude/settings.local.json` / `.factory/settings.local.json` | `src/cli/hooks.ts` | Hook registration (Claude / Factory / VSCode). |
| `.cursor/hooks.json` | `src/cli/hooks.ts` | Cursor hook definitions. |
| `~/.hermes/config.yaml` | `src/cli/hooks.ts` | Hermes (global) hooks + `mcp_servers.uap` + skills bridge. |
| `.uap/omp/settings.json` | `src/cli/hooks.ts` | Oh-My-Pi integration settings. |
| `llama-server.conf` | `src/bin/llama-server-optimize.ts` | Generated llama-server config. |

### `.uap.json` schema (`src/types/config.ts`)

Top level: `version`, `project`, `memory`, `worktree`, `costOptimization`,
`timeOptimization`, plus droids/commands/template sections.

```jsonc
{
  "project": { "name": "...", "description": "...", "defaultBranch": "main" },
  "memory": {
    "shortTerm": {
      "path": "./agents/data/memory/short_term.db",
      "maxEntries": 50
    },
    "longTerm": {
      "provider": "qdrant",            // qdrant|chroma|pinecone|github|qdrant-cloud|serverless|none
      "collection": "agent_memory",
      "embeddingModel": "all-MiniLM-L6-v2",
      "endpoint": "localhost:6333"
    },
    "patternRag": {
      "collection": "agent_patterns",
      "embeddingModel": "all-MiniLM-L6-v2",
      "vectorSize": 384,
      "scoreThreshold": 0.35,
      "topK": 2
    }
  },
  "worktree": { "directory": ".worktrees", "branchPrefix": "feature/" }
}
```

> **Embedding-model nuance.** The config default `embeddingModel` is
> `all-MiniLM-L6-v2` (384-dim), but the runtime embedding provider prefers
> nomic-embed-text via llama.cpp/Ollama (768-dim). Long-term collection vector
> size is therefore 384 (MiniLM/compliance path) or 768 (cloud/nomic runtime)
> depending on backend; pattern RAG is consistently 384.

## Environment variables

| Variable | Controls | Default |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Gates ideate / API-backed flows | — |
| `OPENAI_API_KEY` | OpenAI embedding provider key | — |
| `QDRANT_URL` | Qdrant cloud/serverless endpoint | — |
| `QDRANT_API_KEY` | Qdrant cloud API key | — |
| `GITHUB_TOKEN` | GitHub memory backend PAT | — |
| `UAP_EMBEDDING_ENDPOINT` | Embedding server URL | `http://192.168.1.165:8081` |
| `UAP_INFERENCE_ENDPOINT` | Default LLM inference endpoint | `http://localhost:4000/v1` |
| `UAP_LLM_SERVER` | LLM server selection for tool-call routing | — |
| `UAP_MODEL_PROFILE` | Active model profile name | `generic` |
| `UAP_LOG_LEVEL` | Logger level | `warn` |
| `UAP_DELIVER_MODEL` | Deliver model preset | `qwen35-a3b` |
| `UAP_ESCALATE_MODEL` | Escalation model preset | — |
| `UAP_DELIVER_AUTO` | `0` disables auto-deliver | enabled |
| `UAP_DELIVER_UNTIL_DELIVERED` | `0` disables loop-until-delivered | enabled |
| `UAP_DELIVER_SANDBOX` | Deliver sandbox root path | — |
| `UAP_HALO_TRACE` | `1` enables HALO tracing | off |
| `UAP_HALO_TRACE_PATH` | HALO trace output file | `.uap/halo/traces.jsonl` |
| `UAP_HALO_PROJECT_ID` | HALO project id | `uap` |
| `UAP_AGENT_ID` | Agent id for MCP execute | `mcp-<pid>` |
| `UAP_MAX_PARALLEL` | Override max parallel workers | auto |
| `UAP_PARALLEL` | `false` disables parallelism | enabled |

### `.uap.json` `deliver` section

| Key | What it does | Default |
|---|---|---|
| `deliver.orchestrate` | Blackboard orchestration for decomposed missions (`"on"`/`"off"`) | `"on"` (preflight seeds it) |
| `deliver.epics` | Epic controller outer loop (`"on"`/`"off"`) | `"on"` (preflight seeds it) |
| `deliver.parallelTasks` | Worktree-isolated parallel dispatch: independent READY orchestrator tasks run concurrently, each convergence loop + its gates in a detached git worktree seeded with the mission's current state; deltas merge back serially, and a merge conflict fails the task into the minimal-repair retry. Clamped to 1–8. **Config-only by design — no env override** (an exported variable must never silently parallelize every run). | `1` (sequential) |
| `deliver.autoSizeEpics` | Context auto-size for epic sessions (`false`/`"off"` disables) | enabled |
| `UAP_BENCHMARK_MODE` | `true` enables benchmark template mode | off |
| `UAP_BENCHMARK_PARALLEL` | Parallel model count in benchmarks | — |
| `UAP_SNAPSHOT_DIR` | Base dir for `--keep-best` snapshots (absolute path) | `~/.cache/uap/snapshots` |
| `UAP_SNAPSHOT_MAX_MB` | Skip the `--keep-best` snapshot (rollback disabled) when the tree exceeds this size | `4096` |
| `UAP_DASH_REFRESH_MS` | Dashboard live snapshot push/poll interval in ms (`--refresh` flag wins; min 250) | `2000` |
| `HERMES_HOME` | Hermes home dir | `~/.hermes` |
| `FACTORY_PROJECT_DIR` | Project dir in Factory hook commands | — |
| `FORGE_UAP_PROJECT` | Project dir in ForgeCode hook scripts | `.` |
| `FACTORY_API_KEY` / `DROID_API_KEY` | Factory/droid benchmark API key | — |
| `NODE_ENV` / `UAM_ENV` / `CI` | Serverless env detection | — |
| `HOME` | `~/.uap/omp`, droids dir resolution | — |
| `TMPDIR` | rtk temp dir | `/tmp` |
| `FORCE_INSTALL` | Force rtk reinstall | off |
| `APPDATA` / `USERPROFILE` | Windows MCP config path expansion | — |

Per-model API key env var names are configurable via the model config field
`apiKeyEnvVar` (`src/types/config.ts`), resolved indirectly in
`src/models/openai-compat-client.ts`.

## Database & vector store locations

See `docs/reference/DATABASE_SCHEMA.md` for full schemas. In brief, SQLite DBs
live under `agents/data/memory/`, `agents/data/coordination/`, and `.uap/`;
Qdrant runs as a local Docker container (`qdrant/qdrant:latest`, `uap-qdrant`,
port 6333) or against a cloud endpoint.

# Pattern Library Reference

> Universal Agent Protocol (UAP) v1.40.0

UAP ships an execution-pattern library: a set of reusable problem-solving
strategies that are matched to the current task and surfaced to the agent.
Patterns are defined as markdown files under `.factory/patterns/`, catalogued
in `.factory/patterns/index.json`, and retrieved on demand via a Qdrant-backed
RAG flow (`uap patterns query`).

## The 23 Patterns

The canonical roster lives in `.factory/patterns/index.json`. Each pattern has
a numeric (or string) id, a markdown body file, a title, an abbreviation, a
category, and a keyword set used for retrieval.

| ID | Title | Abbreviation | Category | What it does |
|----|-------|--------------|----------|--------------|
| P12 | Output Existence Verification | OE-Verify | Verification | Confirm the artifact a task was supposed to produce actually exists before claiming done. **Always enforced.** |
| P13 | Iterative Refinement Loop | Iter-Ref | Testing | Run tests, fix, and re-run in a loop until they pass. |
| P14 | Output Format Validation | Format-Check | Verification | Validate that produced output matches the required format (JSON/YAML/CSV). |
| P16 | Task-First Execution | Task-First | Execution | When the task is clear, execute directly instead of over-planning. |
| P17 | Constraint Extraction | Extract-Constraints | Planning | Pull hard constraints ("exactly", "only", "no more than") out of the prompt before acting. |
| P19 | Impossible Task Refusal | Refuse-Impossible | Safety | Detect and refuse tasks that are fundamentally impossible. |
| P20 | Adversarial Thinking | Adversarial | Security | Reason about how something could be bypassed/exploited/evaded. |
| P21 | Chess Engine Integration | Chess-Engine | Domain-Specific | Delegate chess reasoning (FEN, best move, checkmate) to an engine. |
| P22 | Git Recovery Forensics | Git-Recovery | Recovery | Recover lost/corrupted git state via reflog and forensic inspection. |
| P23 | Compression Impossibility Detection | Compress-Check | Verification | Detect already-compressed data so re-compression isn't attempted. |
| P24 | Polyglot Code Construction | Polyglot | Code-Golf | Construct source that compiles/runs as multiple languages. |
| P25 | Service Configuration Pipeline | Service-Config | DevOps | Configure, validate, and reload a service/daemon as a pipeline. |
| P26 | Near-Miss Iteration | Near-Miss | Testing | When a test result is a small gap away, tweak and re-check. |
| P28 | Service Smoke Test | Smoke-Test | Verification | After deploy/start, run a health check / smoke test to verify. |
| P30 | Performance Threshold Tuning | Perf-Threshold | Optimization | Measure performance and tune against a percentage/threshold target. |
| P31 | Round-Trip Verification | Round-Trip | Verification | Encode then decode (or compress/decompress) and verify the round trip. |
| P32 | CLI Execution Verification | CLI-Verify | Verification | Verify a CLI/binary actually runs as expected. |
| P33 | Numerical Stability Testing | Num-Stable | Testing | Test floating-point/numerical work for precision and stability. |
| P34 | Image-to-Structured Pipeline | Image-Structured | Domain-Specific | Convert images (OCR/diagram/board) into structured data. |
| P35 | Decoder-First Analysis | Decoder-First | Analysis | Build/understand the decoder/parser first when reverse-engineering a format. **Always enforced.** |
| P36 | Competition Domain Research | Competition-Research | Research | Research the competitive domain (win rate, leaderboard, tournament) before optimizing. |
| P37 | Ambiguity Detection & Resolution | Ambiguity-Detect | Planning | Detect vague/unspecified requirements and clarify before acting. |
| IaC | Infrastructure as Code Parity | IaC-Parity | Infrastructure | Keep infrastructure changes reflected in IaC (terraform/kubernetes) for reproducibility. |

### Always-on patterns

Two patterns are unconditionally included regardless of the matched task, set
in `src/coordination/pattern-router.ts`:

```js
const alwaysIncludeIds = ['P12', 'P35']; // Output Existence, Decoder-First
```

- **P12 (Output Existence Verification)** — guards against "claiming done"
  without producing the artifact.
- **P35 (Decoder-First Analysis)** — anchors format/reverse-engineering work.

## How pattern RAG works

Pattern retrieval is semantic, not keyword-based. The flow:

1. **Indexing** (`uap patterns index`) runs a generated Python indexer
   (`agents/scripts/index_patterns_to_qdrant.py`). It scans multiple sources —
   `CLAUDE.md` (with `@include` resolution), additional source files
   (`AGENTS.md`, etc.), `*/SKILL.md` skill files, and `.factory/patterns/*.md`
   (using `index.json` to preserve the canonical `PNN: Title` identity and
   keyword set). Documents are de-duplicated by content hash, embedded, and
   upserted into the Qdrant collection.
2. **Querying** (`uap patterns query "<task>"`) runs the generated query script
   (`agents/scripts/query_patterns.py`), embeds the query with the same model,
   and runs a cosine `query_points` search against the collection, returning the
   top-K hits above the score threshold.
3. **Fallback** — if the Python query script is absent, the CLI falls back to a
   direct Qdrant `scroll` + keyword match (less accurate) and prints a notice.

### RAG defaults

From `src/cli/patterns.ts` (`getPatternRagConfig`), overridable via
`.uap.json` under `memory.patternRag`:

| Setting | Default |
|---------|---------|
| Collection | `agent_patterns` |
| Embedding model | `all-MiniLM-L6-v2` |
| Vector size | `384` (Cosine distance) |
| Score threshold | `0.35` |
| Top-K | `2` |
| Index script | `./agents/scripts/index_patterns_to_qdrant.py` |
| Query script | `./agents/scripts/query_patterns.py` |
| Source file | `CLAUDE.md` |
| Max body chars | `400` (display); indexer truncates bodies at 2000 |

The query script requires a Python with `sentence-transformers` and
`qdrant-client`. The CLI auto-discovers `agents/.venv/bin/python`,
`.venv/bin/python`, then `python3`/`python`, and can bootstrap a venv.

## `uap patterns` CLI

| Command | Description |
|---------|-------------|
| `uap patterns status` | Show RAG config, Qdrant collection point count, Python/script availability. |
| `uap patterns index` | (Re)index pattern/doc sources into the Qdrant collection. `--verbose` for full output. |
| `uap patterns query "<task>"` | Semantic search for task-relevant patterns. Flags: `--top <n>`, `--min-score <f>`, `--format text\|json`. |
| `uap patterns generate` | Generate the Python index/query scripts. `--force` to overwrite. |

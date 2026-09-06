# UAP vs Other Agent Harnesses and Tooling

> Applies to UAP v1.224.0. Competitor profiles reflect public sources as of
> September 2026; vendor-reported numbers are flagged as such, and claims we
> could not verify are marked or omitted. UAP's own claims in this document
> were verified against the code.
>
> Companion: [Market Position & Competitive Analysis](../analysis/MARKET_POSITION.md)
> (2026-09) — the dated, strategy-level read (market structure, moats, risks,
> options) above this feature-level comparison.

UAP is frequently miscast as "another agent harness." It isn't one — it's the
**discipline layer that sits underneath the harness you're already using**, and
that positioning determines what an honest comparison looks like. Against
harnesses (Claude Code, Codex, Cursor, Aider, …) UAP is *complementary*: it
installs into them. Against per-capability tooling (memory systems,
orchestration frameworks, spec-driven-development products, review bots,
policy engines) UAP is *comparable*: it ships its own answer to the same
problem. This document does both comparisons, then says plainly where UAP
loses.

---

## The one-slide version

| | Typical agent harness | Typical point tool | **UAP** |
|---|---|---|---|
| What it is | The agent's runtime/UI | One capability (memory OR review OR orchestration) | A process layer under the harness: memory + policy + verification + coordination |
| Model lock-in | Often (Claude Code, Codex, Jules) or partial (Cursor) | Usually none | None — frontier or local llama.cpp/Qwen |
| Rules are | Conventions in a context file | Config of the point tool | **Executable hooks that block** (exit 2), 32 enforcers |
| "Done" means | The model says so | N/A | Your **real gates pass**, judged by a different checker than the writer |
| Memory | Context files (CLAUDE.md / AGENTS.md / rules) | The product (Mem0, Zep, Letta) | 4-tier memory with write-gates + promotion, built in |
| Multi-agent | Subagents, cloud task pools | N/A or framework | Live file-claim blocking across worktrees + deploy batching |
| Cost | Subscription / API | Free tier → per-seat SaaS | MIT, self-hosted, free |

---

## 1. UAP vs agent harnesses (complementary, not competitive)

UAP installs hooks into the harness and mediates its tool calls; it does not
replace the model, the UI, or the session runtime. It currently supports
[9 harnesses](PLATFORMS.md) — Claude Code, Factory, Cursor, VSCode, OpenCode,
Codex, ForgeCode, Oh-My-Pi, Hermes.

| Harness | Layer | Memory | Extensibility | Verification gate | Multi-agent | Models | License |
|---|---|---|---|---|---|---|---|
| **Claude Code** | CLI + IDE/web | CLAUDE.md, skills | Richest hook surface (PreToolUse etc.), MCP, subagents | Convention + hooks; `/verify` skill (2026) | Subagents, Agent SDK | Anthropic only | Proprietary |
| **OpenAI Codex** | CLI + cloud + IDE | AGENTS.md | MCP, skills, sandbox/approvals | Cloud sandbox + diffs; tests user-configured | Parallel cloud tasks | OpenAI only | CLI Apache-2.0, usage paid |
| **Cursor** | IDE + CLI | .cursor/rules, Memories | MCP, rules, BugBot | Prompt/rule-driven | Background/cloud agents | Multi + own Composer | Proprietary freemium |
| **Aider** | Terminal CLI | CONVENTIONS.md, config | Config, scripting (no MCP) | **Auto-lint/auto-test built in** — the closest to UAP's gate loop among harnesses | Single-session | Fully agnostic | Apache-2.0 |
| **OpenCode** | TUI + desktop + IDE | AGENTS.md | MCP, plugins, custom agents | In-session commands; no hard gate | Subagents, headless run | 75+ providers | Open source |
| **Cline** | IDE ext + CLI/SDK | .clinerules, Memory Bank | MCP (originated the marketplace), approvals | Human approval per step; checkpoints | Single; SDK scripting | BYOK 30+ providers | Apache-2.0 |
| **Factory Droid** | Harness platform | Sessions, instruction files, skills | Skills, MCP, plugins, Spec Mode | Spec Mode + CI droids; configurable | Missions, parallel droids, worktrees | Model-agnostic | Proprietary SaaS |
| **Gemini CLI / Jules → Antigravity** | CLI (sunset 2026) + async cloud | GEMINI.md | MCP, extensions | Jules runs tests in VM + PR approval | Task pool; Antigravity multi-agent | Gemini only | Mixed |
| **Devin (Cognition)** | Autonomous cloud agent + IDE (absorbed Windsurf, June 2026) | Playbooks, persistent VMs | API, webhooks | Runs tests in own VM before PR | Parallel sessions | Proprietary SWE + frontier | Commercial |

### What a harness gives you that UAP doesn't

The agent itself: the UI, the session loop, the tool surface, the model
subscription, and (for the commercial ones) support. If you have no harness,
UAP is not the thing to install first.

### What UAP adds underneath any of them

- **Executable policy, not conventions.** Every harness above persists guidance
  as *context files* (CLAUDE.md, AGENTS.md, .cursor/rules) — prose the model
  may honor or ignore. UAP turns the same rules into hook-bound Python
  enforcers that return exit 2 and **block** the tool call: worktree isolation,
  test deltas, schema diffs, expert review, quality budgets. The harness's own
  hook surface (Claude Code's is the strongest) is the mounting point, not a
  substitute.
- **A hard definition of done.** Aider's auto-test and Jules's VM runs are
  real verification, but they answer "did the edit pass" for one edit. UAP's
  `deliver` loop iterates against your *project's* gates (build → typecheck →
  test → lint → declared custom gates → execution/polyglot gates) until they
  pass, with a separate acceptance judge — the generator never grades its own
  homework.
- **Cross-harness consistency.** The same policy file, memory, and gate set
  applies whether today's session runs in Claude Code and tomorrow's in
  OpenCode — harness choice becomes a preference, not a process change.
- **Local-model viability.** The inference proxy's guardrails (loop-breakers,
  empty-output recovery, grammar constraints, model-slot leases) make cheap
  local models (llama.cpp/Qwen) usable on the same floor as frontier models.

---

## 2. UAP vs memory & context tooling

| Tool | Layer | Memory model | Write quality control | Consumption | Benchmarks | License |
|---|---|---|---|---|---|---|
| **Mem0** | Library + SaaS (+ MCP via OpenMemory) | Semantic facts, multi-scope; optional graph | LLM ADD/UPDATE/DELETE/NOOP gate with dedup | SDK, REST, MCP | LoCoMo 92.5, LongMemEval 94.4 *(vendor-reported)* | Apache-2.0 + paid tiers |
| **Zep / Graphiti** | Service + OSS engine | Temporal bi-temporal knowledge graph | Entity resolution + edge invalidation | SDK, REST, MCP | DMR > MemGPT (2025 paper) | Graphiti Apache-2.0; Zep commercial |
| **Letta** | Agent runtime | Core/archival/recall blocks, agent self-edits | Agent's own tool-call judgment; no auto-dedup | SDK, REST, ADE, MCP | No fresh 2026 public numbers | Apache-2.0 + cloud |
| **Context7** | MCP server | None — doc injection, not memory | Server-side curation | MCP | None published | OSS + freemium |
| **LLMLingua line** | Library | None — prompt compression | N/A | pip | 20× compression (EMNLP'23) | MIT; stable, low momentum |
| **LangMem / LlamaIndex memory** | Framework modules | Semantic/episodic/procedural | Configurable extractors | SDK | None public | OSS |
| **UAP memory** | Built into the discipline layer | **4 tiers**: working (SQLite FTS5) → session → semantic (Qdrant, 768-dim) → knowledge graph | Score-gated writes + consolidation + promotion; dedup by hash + embedding similarity | CLI + hook injection into 9 harnesses | Not independently benchmarked on LoCoMo/LongMemEval | MIT |

### Where the specialists win

Mem0, Zep, and Letta are *products about memory*: managed services, enterprise
compliance (Zep is SOC 2), published benchmark numbers (Mem0's are
vendor-reported), SDK ecosystems, and 20+ framework integrations. If you are
*building* an agent product and need a memory API, use one of them — UAP's
memory is not exposed as a general-purpose service, has no hosted tier, and
has not been run against the standard memory benchmarks.

### Where UAP differs

UAP's memory is **operational, not archival**: its tiers exist to keep a coding
agent's *workflow* honest (recent actions, open loops, promoted lessons), and
its distinguishing feature is the feedback loop — lessons graduate from
session notes to long-term memory only through a quality write-gate, and
patterns that stop paying off fade (pattern reinforcement). It is also the
only option in the table that arrives pre-wired into the agent's session
lifecycle (injected at session start, recorded per turn) across nine harnesses
with zero application code. Context7-style doc injection and LLMLingua-style
compression have their UAP analogues in the MCP Router (tool hiding + FTS5
BM25 output compression, ~98% smaller big-tool payloads) — again, hook-native
rather than an API you integrate.

---

## 3. UAP vs orchestration frameworks

| Framework | Model-agnostic | Durable state | Human-in-loop | Executable gates | License | Maturity |
|---|---|---|---|---|---|---|
| **LangGraph** | Yes | Strong (checkpoints; Temporal plugin) | Strong (interrupts) | Advisory/external (LangSmith evals) | MIT | Very high — the default |
| **CrewAI** | Yes | Partial | Per-task | Output validators; enterprise governance tier | MIT + commercial | High |
| **AutoGen → MS Agent Framework** | Yes | Legacy → improved in successor | Yes | Advisory | MIT | AutoGen in maintenance; successor young |
| **OpenAI Agents SDK** | OpenAI-first | Sessions only | Patterns | Guardrails primitive (LLM-level) | MIT | High |
| **Google ADK** | Gemini-first | Pluggable sessions | Callbacks | Built-in eval framework (`adk eval`) | Apache-2.0 | High, growing |
| **UAP** | Yes (incl. local models) | SQLite task DAG + coordination DB + run state | Operator guidance channel mid-run | **Yes — exit-code-blocking enforcers + real-gate convergence loop** | MIT | Single-operator production use |

These frameworks answer "how do I *build* a multi-agent application in code";
UAP answers "how do I *govern* the coding agents I already run." The overlap
is real but narrow — if you use LangGraph to build an agent product, you could
still put UAP under the coding agents that maintain that product's repo. The
sharpest differences: none of the frameworks ship executable, deterministic
gates on what the agent may *do to a codebase* (their guardrails are LLM-level
validators), and none carry a verification loop tied to the project's real
build/test/lint. Conversely, UAP has no visual graph builder, no
checkpoint-replay durability à la LangGraph+Temporal, and no framework-level
abstractions for novel agent topologies.

---

## 4. UAP vs spec-driven development & agent governance

| Tool | What it does | Enforcement mode | License |
|---|---|---|---|
| **GitHub spec-kit** | Structured specify → plan → tasks → implement workflow with a project "constitution" | Prompt-level templates and checklists | MIT |
| **AWS Kiro** | Spec workflow (EARS requirements → design → tasks) + event-driven agent hooks | **Mixed**: hooks are executable; specs/steering are prompt-level | Proprietary |
| **Tessl** | Pivoted Jan 2026 to an "Agent Enablement Platform" (skills registry); spec-driven skills remain | Prompt-level + eval scenarios | Proprietary |
| **AGENTS.md convention** | The de facto standard agent-readme; 60k+ repos, 20+ tools read it | None — convention only | Open format |
| **UAP** | Reads the same instruction files (CLAUDE.md/AGENTS.md) *and* binds their rules to hook-enforced gates; plan validation gate; P35 decoder-first pre-execution check | **Executable** for the rules it covers (edit/commit/ship plane); prompt-level for everything else | MIT |

The axis that matters here is *suggests vs blocks*. Spec-kit, AGENTS.md, and
Tessl's skills improve what the agent *knows*; Kiro's hooks and UAP's
enforcers constrain what the agent *does*. UAP and Kiro are the only two with
an executable component; Kiro's hooks automate *tasks* (on file save, run X),
while UAP's hooks *gate the action itself* (block the write, the push, the
merge). They compose fine — a spec-kit constitution can name UAP's gates as
the enforcement mechanism.

---

## 5. UAP vs verification, review & policy engines

| Tool | What it gates | Where it sits | Executable? | License |
|---|---|---|---|---|
| **SWE-agent** | Nothing itself — research scaffold measured by SWE-bench | Task execution | N/A | MIT |
| **CodeRabbit** | PR review (bugs, security, custom rules) | **PR stage** | Via platform merge checks; findings advisory | Proprietary SaaS |
| **Greptile** | PR review with full-repo context | PR stage (self-host option in v3) | Via merge checks; advisory by default | Proprietary |
| **NeMo Guardrails** | Agent I/O: injection, dialog, tool-call constraints | Runtime middleware | Yes — blocking rails | Apache-2.0 |
| **OPA (agent use)** | Which tools an agent may call, with what parameters — now a first-class OPA use case (OWASP Agentic Top 10 write-ups) | Runtime middleware | Yes — deterministic Rego deny | Apache-2.0 (CNCF) |
| **UAP** | Codebase integrity: where edits land, whether tests/builds/schema/review gates ran, quality budgets, trust anchors | **Edit/commit/ship plane**, pre-PR | Yes — exit-2 hook enforcers, fail-closed | MIT |

### The real distinctions

- **Stage.** CodeRabbit/Greptile review *after* the code is written, at the PR.
  UAP gates *while* the agent is writing — the violation never becomes a commit.
  They compose well: UAP reduces what the PR reviewer has to catch.
- **Determinism.** OPA and UAP are the deterministic options: policy-as-code
  with no LLM in the verdict path. OPA is the more general, more battle-tested
  engine (CNCF-graduated, huge ecosystem) and the better choice for
  platform-wide authorization. UAP's enforcers trade that generality for being
  **pre-built for coding-agent failure modes** (worktree discipline, test
  gates, self-protection against an agent disabling its own guardrails —
  including interpreter-mediated tampering) and for hooking directly into
  harness events with no sidecar to run.
- **Verification depth.** Nobody else in this table runs the project's real
  build/test/lint as a convergence gate with a separate acceptance judge.
  SWE-agent measures agents; UAP's paired harness (`uap bench paired`)
  measures *its own* uplift with controlled A/B — see
  [benchmarks](../benchmarks/PAIRED_FINDINGS.md).
- **UAP's quality gate vs review bots.** CodeRabbit-style review is LLM
  judgment; UAP's `quality` gate is deterministic budgets (complexity, CRAP,
  coverage, mutants, duplicates, `any` types) with a ratchet baseline — the
  two catch different things.

---

## 6. Where UAP loses — honest trade-offs

1. **Single-operator tool.** No user auth, no teams, no hosted service, no
   enterprise compliance story (Zep/Mem0/Cognition all have one). The
   dashboard binds unauthenticated; it's a local console.
2. **Not a harness.** You still need Claude Code/OpenCode/etc. underneath;
   UAP alone runs no agent.
3. **Not a framework.** No graph builder, no replay durability, no agent-topology
   abstractions — LangGraph/ADK territory.
4. **Memory is not benchmarked.** Mem0/Zep publish LoCoMo/LongMemEval/DMR
   numbers (vendor caveats aside); UAP's memory has none. Its benchmark
   discipline is applied to *delivery uplift* instead (paired A/B with CIs).
5. **Platform breadth.** The kernel sandbox is Linux-only (bubblewrap); hook
   depth varies by harness; the full memory tier wants Docker/Qdrant.
6. **Ecosystem size.** One vendor, MIT, small community vs LangChain-scale
   ecosystems; fewer integrations, fewer eyes.
7. **Enforcement has a known escape hatch.** `--dangerously-skip-permissions`
   bypasses harness hooks by design; UAP's compensating control is the bwrap
   sandbox, not the hook plane.
8. **Vendor momentum elsewhere.** The 2026 market moved fast (Windsurf → Devin
   Desktop, Gemini CLI → Antigravity, AutoGen → Agent Framework, Tessl's
   pivot); harness-specific UAP integrations can lag those shifts.

---

## 7. Choosing

- **Building an agent product in code** → LangGraph / Google ADK (+ Mem0 or
  Zep for memory). UAP is irrelevant to your runtime, useful for your repo.
- **Running coding agents on a real codebase and tired of unverified "done"** →
  UAP under your current harness; add CodeRabbit/Greptile at the PR if you
  want a second, post-hoc net.
- **Regulated / multi-tenant agent authorization** → OPA as the policy engine;
  UAP's enforcers are the coding-agent-specific complement.
- **Local-model shop** → UAP's proxy + guardrails + routing are the differentiator;
  nothing else in this document is built for that floor.

## Sources & method

UAP capabilities verified against the v1.224.0 codebase (see
[FEATURES.md](FEATURES.md), [architecture](../architecture/OVERVIEW.md)).
Competitor profiles compiled September 2026 from vendor docs and secondary
reviews; vendor-reported benchmark and adoption figures are flagged inline,
and market events we could not confirm from primary sources (e.g. a reported
Cursor–Continue acquisition) were omitted. Corrections welcome via PR.

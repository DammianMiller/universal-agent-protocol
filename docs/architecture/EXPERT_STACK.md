# Expert Stack: Forward-Design, HALO & Open-Collider

This document covers the expert-system extensions added on top of the v1.23.0
droid stack: forward-design experts, the activated experts-as-MCP-tools surface,
HALO trace-based harness optimization, open-collider divergent ideation, and the
expert-review hard gate.

> Scope note: the base 33-droid roster, `ExpertOrchestrator`, `expert-route`
> CLI, and `parallel-expert-review` skill already shipped in v1.23.0. This layer
> closes real gaps in that stack and integrates two external tools.

---

## 1. Forward-design droids

The pre-existing roster was review-heavy — the orchestrator's `plan`/`design`
phases produced no up-front design. Three forward-design experts fill that gap:

| Droid | Phase | Role |
|---|---|---|
| `strategic-architect` | plan | North-star architecture, technology selection (OSS-first), multi-quarter evolution, one-way-door decisions. Forward-design counterpart to `architect-reviewer`. |
| `tactical-architect` | design | Concrete component/module boundaries, interfaces, data shapes, pattern selection, refactor strategy. |
| `implementation-planner` | design | Executable work breakdown: ordered steps, file-level plan (reuse-first), test plan, risk/rollback. Feeds the `validate-plan-before-build` gate. |

Wiring: `src/coordination/expert-orchestrator.ts` — `PHASE_ROSTER.plan` gains
`strategic-architect`; `PHASE_ROSTER.design` gains `tactical-architect` and
`implementation-planner`; `isRelevantForCapability` maps them to the
`architecture`/`api-design` capabilities so they appear only on relevant tasks.

```bash
uap expert-route "Design a new billing subsystem" --files src/types/billing.ts --json
# → plan: strategic-architect … design: tactical-architect, implementation-planner …
```

---

## 2. Experts as MCP tools (activated)

`src/mcp-router/experts/registry.ts` could already convert droids to virtual
`experts.<name>` tools (`loadExpertTools`) but was never wired in. Now:

- `McpRouter.loadTools()` (`src/mcp-router/server.ts`) calls `loadExpertTools(cwd)`
  and adds the experts to the fuzzy search index.
- `handleExecuteTool` (`src/mcp-router/tools/execute.ts`) intercepts
  `experts.<droid>` paths and dispatches an in-process `consultExpert()` — it
  loads the droid's instructions and returns them wrapped as a prompt (mirroring
  `uap_droid_invoke`), instead of routing to an external MCP server.

Result: `discover_tools "architecture review"` surfaces the right expert and
`execute_tool experts.architect-reviewer` returns a consultation — all within
the 2-tool token-saving router shape.

---

## 3. HALO — trace-based harness optimization

[HALO](https://github.com/context-labs/HALO) analyzes large volumes of execution
traces to find *systemic* harness/prompt failure modes (not one-off errors). UAP
integrates it as an exporter + a droid + a CLI.

**Exporter** (`src/observability/halo-exporter.ts`) — opt-in, zero-overhead when
off. Emits one JSONL span per agent/LLM/tool call in HALO's OTLP/OpenInference
shape: OTLP identity, `resource.attributes."service.name"`, and the four
`inference.*` attributes (`project_id`, `observation_kind`, `export.schema_version`,
`openinference.span.kind`), with nanosecond-precision timestamps.

Tap points: `execute.ts:handleExecuteTool` (TOOL spans) and
`session-telemetry.ts` `agentComplete`/`agentError` (AGENT spans).

```bash
export UAP_HALO_TRACE=1                  # enable collection
export UAP_HALO_TRACE_PATH=.uap/halo/traces.jsonl
# … run your workflow …
uap harness status                       # enabled? path? span count?
uap harness analyze -p "systemic failure modes?"   # wraps `halo <file> -p ...`
```

**Prerequisite:** `pip install halo-engine` (Python ≥3.10) + an OpenAI-compatible
endpoint. Each analysis run incurs LLM cost. The `harness-optimizer` droid runs
the loop: diagnose → **verify each claim against the repo** → route fixes →
re-measure. Hard rule: *ask HALO about the trace data; never ask it to write code.*

---

## 4. Open-Collider — divergent ideation

[open-collider](https://github.com/CL-ML/open-collider) escapes LLM "hivemind"
clustering by colliding structurally distant knowledge domains (Koestler
bisociation), then curating non-trivial ideas. Skill mode is free.

- `ideation-expert` droid drives the brief → domains → collide → curate flow.
- `uap ideate setup <name>` scaffolds the `projects/<name>/` file contract
  (`brief_validated.json`, `input_bank.yaml`, `prompts/`, `texts/`).
- `uap ideate run <name>` drives the brainstorm; `uap ideate ideas <name>` reads
  the newest `curated_ideas.json`.
- Orchestrator opt-in: `new ExpertOrchestrator({ includeIdeation: true })`
  prepends an `ideate` phase feeding the plan-phase product/strategy droids.
  `readCuratedIdeas()` (`src/cli/ideate.ts`) is the consumable artifact.

Use it only when the solution space is wide; skip for convergent tasks.

---

## 5. Expert-review hard gate

The `parallel-expert-review` skill claimed "REQUIRED by policy" but nothing
enforced it. Two policy artifacts close that:

- `expert-review-required` (`src/policies/schemas/policies/expert-review-required.md`
  + `src/policies/enforcers/expert_review_required.py`): blocks ship actions
  (`git commit`/`push`, `gh pr create`, merge/pr-ready/signoff) unless
  `.uap/reviews/<branch-slug>.json` exists and covers `HEAD` (stale → block).
  Fail-open on detached/non-git; override `UAP_NO_REVIEW=1`.
- `architecture-review` (`…/policies/architecture-review.md`): the missing
  backing doc for the previously-orphan `architecture_review.py` enforcer
  (ADR-or-waiver on architecturally significant diffs).

The review flow writes the artifact on consolidation:
`{ "head": "<sha>", "verdict": "approve", "reviewers": [...] }`. Install with:

```bash
uap policy install expert-review-required   # attaches the enforcer to the hook
```

---

## File map

| Concern | Path |
|---|---|
| Forward-design droids | `.factory/droids/{strategic-architect,tactical-architect,implementation-planner}.md` |
| Orchestrator wiring | `src/coordination/expert-orchestrator.ts` |
| Experts-MCP dispatch | `src/mcp-router/experts/registry.ts`, `server.ts`, `tools/execute.ts` |
| HALO exporter | `src/observability/halo-exporter.ts` |
| HALO droid + CLI | `.factory/droids/harness-optimizer.md`, `src/cli/harness.ts` |
| Ideation droid + CLI | `.factory/droids/ideation-expert.md`, `src/cli/ideate.ts` |
| Review gate | `src/policies/{schemas/policies/expert-review-required.md,enforcers/expert_review_required.py}` |

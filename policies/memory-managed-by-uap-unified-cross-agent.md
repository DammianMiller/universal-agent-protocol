# memory-managed-by-uap-unified-cross-agent

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, CLAUDE

## Rule

Your persistent memory is the **UAP memory system** — ONE store shared by every
coding agent on this project, NOT a per-agent memory file. Use it, not a local one:

- **Recall FIRST** on non-trivial work: `uap memory query "<topic>"` (semantic long-term search).
- **Store** durable facts/decisions/lessons: `uap memory store "<fact>"`.
- **Status**: `uap memory status`.

Recent UAP memories (auto-mirrored — do not hand-edit; refresh with `uap memory bridge`):
  - (thought, i5) UAP installs hooks into your agent harness, then mediates every tool call through the memory, policy, and token-optimization layers — a cont
  - (observation, i5) Available skills: SKILL-TEMPLATE, sec-context-review. These provide specialized capabilities.
  - (observation, i5) Available AI agents/droids: accessibility-tester (factory), api-designer (factory), architect-reviewer (factory), cli-design-expert (factory
  - (observation, i5) Bug fixed: fix: pytest integration rung — vacuous pass on exit 5, --no-cov with pytest-cov|The rung is added whenever a pytest config DECLAR
  - (observation, i5) Bug fixed: fix: never bait the executor with optional-gate failure tails|formatFeedback fell back to the first OPTIONAL failure with the sam
  - (observation, i5) Bug fixed: fix(hooks): stop the fresh-install Claude Code Stop-hook infinite loop|On a fresh/empty project the Stop hook exited 2 forever, f
  - (observation, i5) Bug fixed: fix(dashboard): bind ephemeral port in tests to kill EADDRINUSE flake|The dashboard tests picked a port with `3800 + Date.now()%9
  - (observation, i5) Bug fixed: fix(proxy): clients could never see their context usage — scale + report input_tokens on every wire surface|Follow-up to #405 (co

Read and write here so every agent compounds the same knowledge instead of siloed recall.
<!-- UAP-MEMORY-BRIDGE:END -->

<!-- CLAUDE.md v2.3.0 - 34 Model Outcome Success Optimizations + Hooks Enforcement -->
<!-- Optimizations #22-27: Template Compression, Structured Iteration, Inline Domain Knowledge, Early Impossibility Exit, Conditional Context, Remove Emphasis Theater -->
<!-- Optimizations #28-34: Mandatory Verifier Loop, Decoder-First Gate, Context Stripping, Environment Check, Schema Diff, State Protection, Conditional Domain -->

<!-- ENFORCEMENT_CHECKS: SESSION_START,DECISION_LOOP,MANDATORY_WORKTREE,PARALLEL_REVIEW,SCHEMA_DIFF,GATES,RTK_INCLUDES,PATTERN_ROUTER,VALIDATE_PLAN -->
<!-- TEMPLATE_VERSION: 2.3.0 -->
<!-- LAST_VALIDATED: 2026-03-09 -->

@hooks-session-start.md
@PreCompact.md

<!-- Custom Sections (preserved from existing file) -->

## Why

Extracted from CLAUDE.md during `uap setup` — a project-specific rule promoted to a reviewable UAP policy.

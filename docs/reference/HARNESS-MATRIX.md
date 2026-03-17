# UAP Harness Feature Matrix

**Version:** 1.1.0 | **Last Updated:** 2026-03-15 | **Status:** Production Ready

---

## Executive Summary

AI coding harnesses -- Claude Code, Cursor, Cline, Aider, and others -- are stateless code editors. They read files, run commands, and forget everything when the session ends. UAP turns any of them into a persistent, coordinated agent platform.

**What UAP adds to every harness, and why:**

- **4-layer persistent memory (L1-L4)** -- agents retain lessons, decisions, and corrections across sessions instead of re-discovering the same things
- **Write gate with 5-criteria scoring** -- prevents memory pollution; only behavioral changes, commitments, decisions, stable facts, and explicit requests are stored
- **Hot/warm/cold memory tiering** -- keeps the 10 most relevant memories in context at <1ms, promotes on access, so agents always have the right knowledge without token bloat
- **22 battle-tested patterns** -- Terminal-Bench 2.0 workflows that eliminate the 37% of agent failures caused by missing outputs, wrong formats, and skipped verification
- **Pattern RAG via Qdrant** -- injects only relevant patterns on demand, saving ~12K tokens per session versus loading all patterns upfront
- **Git worktree isolation** -- each agent gets its own worktree (`001-feature`, `002-bugfix`), so parallel agents never corrupt shared state
- **Multi-agent coordination** -- heartbeats, overlap detection, conflict risk levels (`none` through `critical`), and exclusive claims let 2-10+ agents work the same repo safely
- **Deploy batching** -- squashes commits and serializes pushes so multiple agents finishing simultaneously don't cause push races or deploy storms
- **Policy enforcement with audit trail** -- required/recommended/optional rules block or log violations, with every check recorded for compliance review
- **Task DAG management** -- dependency-aware task tracking with cycle detection, JSONL sync for git versioning, and automatic next-task suggestion
- **Multi-model routing** -- classifies subtasks by complexity and routes to the optimal model across 6 presets, reducing cost without sacrificing quality
- **MCP Router** -- replaces N tool definitions with 2 meta-tools, cutting system prompt tokens by 98% (from ~12K to ~200)
- **RTK (Rust Token Killer)** -- compresses command output by 60-90%, so agents spend tokens on reasoning instead of parsing verbose logs
- **12-gate compliance checking** -- automated protocol verification catches configuration drift, missing hooks, and policy gaps before they ship
- **20+ CLI commands with dashboard** -- full system management from the terminal, including 6 sub-dashboards for memory, coordination, tasks, patterns, models, and deploy status

**The bottom line:** no harness provides any of these capabilities natively. UAP delivers them uniformly across all 15 supported harnesses. The only difference between harnesses is integration depth (native hooks vs. context-file passthrough), not feature availability.

---

## Table of Contents

1. [Supported Harnesses](#1-supported-harnesses)
2. [Baseline Feature Matrix](#2-baseline-feature-matrix)
3. [UAP-Enhanced Feature Matrix](#3-uap-enhanced-feature-matrix)
4. [Integration Tiers](#4-integration-tiers)
5. [Per-Harness Integration Method](#5-per-harness-integration-method)
6. [The UAP Delta](#6-the-uap-delta)
7. [Feature Flags](#7-feature-flags)

---

## 1. Supported Harnesses

UAP supports **15 harnesses** organized into 4 tiers by integration depth.

| Tier                   | Harnesses                                    | Integration Depth                                                       |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| **T1 -- First-Class**  | Claude Code, Factory.AI, OpenCode, ForgeCode | Native hooks, dedicated config dir, `uap sync`, context file generation |
| **T2 -- IDE-Based**    | Cursor, VSCode, Cline                        | Platform-specific hooks, MCP config paths                               |
| **T3 -- CLI/Terminal** | Codex CLI, Aider, Windsurf, Zed AI, Continue | Mapped to T1/T2 via CLAUDE.md or .cursorrules                           |
| **T4 -- Additional**   | GitHub Copilot, JetBrains AI, SWE-agent      | Piggybacks on T2 infrastructure                                         |

<details>
<summary>Harness-to-platform mapping details</summary>

### Tier 1 -- First-Class

| Harness     | Platform Mapping | Hook Target | Config Directory |
| ----------- | ---------------- | ----------- | ---------------- |
| Claude Code | `claude`         | `claude`    | `.claude/`       |
| Factory.AI  | `factory`        | `factory`   | `.factory/`      |
| OpenCode    | `opencode`       | `opencode`  | `.opencode/`     |
| ForgeCode   | `opencode`       | `forgecode` | `.forge/`        |

### Tier 2 -- IDE-Based

| Harness | Platform Mapping | Hook Target |
| ------- | ---------------- | ----------- |
| Cursor  | `vscode`         | `cursor`    |
| VSCode  | `vscode`         | `vscode`    |
| Cline   | `vscode`         | `vscode`    |

### Tier 3 -- CLI/Terminal Agents

| Harness   | Platform Mapping | Hook Target |
| --------- | ---------------- | ----------- |
| Codex CLI | `claude`         | `claude`    |
| Aider     | `claude`         | `claude`    |
| Windsurf  | `vscode`         | `cursor`    |
| Zed AI    | `claude`         | `claude`    |
| Continue  | `vscode`         | `vscode`    |

### Tier 4 -- Additional Integrations

| Harness        | Platform Mapping | Hook Target |
| -------------- | ---------------- | ----------- |
| GitHub Copilot | `vscode`         | `vscode`    |
| JetBrains AI   | `vscode`         | `vscode`    |
| SWE-agent      | `claude`         | `claude`    |

</details>

---

## 2. Baseline Feature Matrix

What each harness provides **natively, without UAP**.

| Feature                      | Claude Code | Factory.AI |  OpenCode  |    ForgeCode    |    Cursor    | VSCode  |    Cline    |    Windsurf    | Codex CLI |  Aider   | Zed AI | Copilot | JetBrains | SWE-agent | Continue |
| ---------------------------- | :---------: | :--------: | :--------: | :-------------: | :----------: | :-----: | :---------: | :------------: | :-------: | :------: | :----: | :-----: | :-------: | :-------: | :------: |
| **Runtime**                  |     CLI     |    CLI     |    CLI     |       ZSH       |     IDE      |   IDE   |   IDE ext   |      IDE       |    CLI    |   CLI    |  IDE   | IDE ext |  IDE ext  |    CLI    | IDE ext  |
| **File system + terminal**   |     Yes     |    Yes     |    Yes     |       Yes       |     Yes      |   Yes   |     Yes     |      Yes       |    Yes    |   Yes    |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| **Context file**             |  CLAUDE.md  | PROJECT.md |     --     |       --        | .cursorrules |   --    | .clinerules | .windsurfrules |    --     | .aider\* |   --   |   --    |    --     |    --     |    --    |
| **Native hooks**             |     Yes     |    Yes     | Plugin API |    ZSH hooks    |  hooks.json  |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **MCP support**              |   Native    |   Native   |   Config   |       --        |    Native    | Via ext |   Via ext   |    Via ext     |    --     |    --    |   --   |   --    |    --     |    --     | Via ext  |
| **Persistent sessions**      |     Yes     |    Yes     |    Yes     |     ZSH env     |   Limited    | Limited |   Limited   |    Limited     |    --     |    --    |   --   | Limited |  Limited  |    --     | Limited  |
| **Multi-agent modes**        |     --      |     --     |     --     | FORGE/MUSE/SAGE |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Local LLM support**        |     --      |     --     |   Native   |       Yes       |     Yes      | Via ext |     Yes     |      Yes       |    --     |   Yes    |   --   |   --    |    --     |    --     |   Yes    |
| **Persistent memory**        |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Cross-session memory**     |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Semantic search**          |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Knowledge graph**          |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Pattern library**          |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Worktree isolation**       |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Multi-agent coordination** |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Deploy batching**          |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Policy enforcement**       |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Task DAG management**      |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Model routing**            |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |
| **Compliance checking**      |     --      |     --     |     --     |       --        |      --      |   --    |     --      |       --       |    --     |    --    |   --   |   --    |    --     |    --     |    --    |

The bottom 12 rows are empty across every column. No harness provides them. This is the gap UAP fills.

---

## 3. UAP-Enhanced Feature Matrix

What each harness gains **after `uap init`**. Every feature below is delivered uniformly by UAP.

| Capability                         | Why It Matters                                   | All 15 Harnesses |
| ---------------------------------- | ------------------------------------------------ | :--------------: |
| **4-layer memory (L1-L4)**         | Agents remember across sessions                  |       Yes        |
| **Write gate**                     | Only high-value knowledge stored, no noise       |       Yes        |
| **Memory tiering (hot/warm/cold)** | Right knowledge at right time, minimal tokens    |       Yes        |
| **Correction propagation**         | Fix a memory once, corrected everywhere          |       Yes        |
| **Agent-scoped memory**            | Per-agent isolation with explicit sharing        |       Yes        |
| **22 patterns**                    | Proven workflows prevent 37% of common failures  |       Yes        |
| **Pattern RAG**                    | ~12K token savings per session                   |       Yes        |
| **Worktree isolation**             | Parallel agents, zero git conflicts              |       Yes        |
| **Multi-agent coordination**       | Heartbeats, overlap detection, conflict risk     |       Yes        |
| **Deploy batching**                | No push races, squashed commits                  |       Yes        |
| **Policy engine**                  | Audit-trailed rule enforcement                   |       Yes        |
| **Task DAG**                       | Dependency-aware tracking with cycle detection   |       Yes        |
| **Model router**                   | Right model for each subtask, lower cost         |       Yes        |
| **MCP Router**                     | 98% system prompt token reduction                |       Yes        |
| **RTK compression**                | 60-90% output token savings                      |       Yes        |
| **12-gate compliance**             | Automated protocol verification                  |       Yes        |
| **Droid system**                   | Specialized expert agents (security, perf, docs) |       Yes        |
| **20+ CLI commands**               | Full management + 6 dashboards                   |       Yes        |

<details>
<summary>Full per-harness breakdown with tier and hook target</summary>

| UAP Feature              | Claude Code | Factory.AI | OpenCode | ForgeCode | Cursor | VSCode | Cline  | Windsurf | Codex CLI | Aider  | Zed AI | Copilot | JetBrains | SWE-agent | Continue |
| ------------------------ | :---------: | :--------: | :------: | :-------: | :----: | :----: | :----: | :------: | :-------: | :----: | :----: | :-----: | :-------: | :-------: | :------: |
| **Integration Tier**     |     T1      |     T1     |    T1    |    T1     |   T2   |   T2   |   T2   |    T3    |    T3     |   T3   |   T3   |   T4    |    T4     |    T4     |    T4    |
| **Hook Target**          |   claude    |  factory   | opencode | forgecode | cursor | vscode | vscode |  cursor  |  claude   | claude | claude | vscode  |  vscode   |  claude   |  vscode  |
| **Platform Mapping**     |   claude    |  factory   | opencode | opencode  | vscode | vscode | vscode |  vscode  |  claude   | claude | claude | vscode  |  vscode   |  claude   |  vscode  |
| Working Memory (L1)      |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Session Memory (L2)      |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Semantic Memory (L3)     |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Knowledge Graph (L4)     |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Memory Write Gate        |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Memory Tiering           |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Correction Propagation   |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Agent-Scoped Memory      |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Pattern Library (22)     |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Pattern RAG              |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Worktree Isolation       |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Multi-Agent Coordination |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Deploy Batching          |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Policy Engine            |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Task Management          |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Model Router             |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Compliance (12 gates)    |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| MCP Router               |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| RTK Token Savings        |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Droid System             |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| CLI (20+ commands)       |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |
| Dashboard                |     Yes     |    Yes     |   Yes    |    Yes    |  Yes   |  Yes   |  Yes   |   Yes    |    Yes    |  Yes   |  Yes   |   Yes   |    Yes    |    Yes    |   Yes    |

</details>

---

## 4. Integration Tiers

All tiers receive identical UAP features. The difference is how deeply UAP wires into the harness.

### Tier 1 -- First-Class

**Harnesses:** Claude Code, Factory.AI, OpenCode, ForgeCode

| Aspect                     | Detail                                                       | Why It Matters                                               |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Dedicated config directory | `.claude/`, `.factory/`, `.opencode/`, `.forge/`             | Clean separation from harness config                         |
| Native hook installation   | Direct hook scripts in harness config                        | Hooks fire automatically, no manual setup                    |
| Context file generation    | CLAUDE.md / PROJECT.md auto-generated with UAP directives    | Agent reads project context on every session start           |
| Sync support               | `uap sync` copies droids, skills, commands between platforms | Multi-platform teams stay consistent                         |
| Session hooks              | SessionStart + PreCompact fire automatically                 | Memory injection and preservation happen without user action |
| Auto-approve tools         | Configurable per-harness                                     | Reduces approval friction for trusted operations             |
| Skills/Commands            | Installed into harness-native directories                    | Discoverable through the harness's own UI                    |
| Setup wizard               | Full interactive configuration                               | Guided setup with sensible defaults                          |

### Tier 2 -- IDE-Based

**Harnesses:** Cursor, VSCode, Cline

| Aspect           | Detail                                                           | Why It Matters                                |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| Hook target      | Cursor: `cursor` hooks; VSCode/Cline: `vscode` hooks             | Hooks fire through the IDE's extension system |
| Config directory | `.cursor/` or `.claude/` (VSCode/Cline piggyback on Claude Code) | Reuses existing config infrastructure         |
| MCP config       | Platform-specific paths (`~/.config/Cursor/...`, etc.)           | MCP tools available in the IDE's tool palette |
| Context file     | `.cursorrules` or CLAUDE.md                                      | Agent reads project context through the IDE   |
| Limitation       | VSCode/Cline require "Third-party skills" enabled                | One-time setting change                       |

### Tier 3 -- CLI/Terminal Agents

**Harnesses:** Codex CLI, Aider, Windsurf, Zed AI, Continue

| Aspect       | Detail                                         | Why It Matters                                       |
| ------------ | ---------------------------------------------- | ---------------------------------------------------- |
| Hook target  | Mapped to `claude` or `cursor` hooks           | Reuses T1/T2 hook infrastructure                     |
| Context file | Relies on CLAUDE.md (read by most CLI agents)  | Works because these tools already read context files |
| Limitation   | No dedicated config directory; borrows from T1 | No additional config to maintain                     |

### Tier 4 -- Additional Integrations

**Harnesses:** GitHub Copilot, JetBrains AI, SWE-agent

| Aspect      | Detail                                                  | Why It Matters                                |
| ----------- | ------------------------------------------------------- | --------------------------------------------- |
| Hook target | Mapped to `vscode` or `claude`                          | Reuses existing infrastructure                |
| Limitation  | Most indirect; relies on extension/plugin compatibility | Works through the host IDE's extension system |

---

## 5. Per-Harness Integration Method

| Harness            | Hook Method                                                          | Config Files Created                                              | Special Integration                                              |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Claude Code**    | `bash .claude/hooks/session-start.sh` via `settings.local.json`      | `.claude/settings.local.json`, `.claude/hooks/*.sh`               | CLAUDE.md generation, skills, commands, agents                   |
| **Factory.AI**     | `$FACTORY_PROJECT_DIR/.factory/hooks/*.sh` via `settings.local.json` | `.factory/settings.local.json`, `.factory/hooks/*.sh`             | Droids, skills, patterns, PROJECT.md                             |
| **OpenCode**       | TypeScript plugin in `.opencode/plugin/uam-session-hooks.ts`         | `.opencode/plugin/uam-session-hooks.ts`, `.opencode/package.json` | Plugin API integration, local LLM config                         |
| **ForgeCode**      | ZSH plugin `.forge/forgecode.plugin.sh`                              | `.forge/forgecode.plugin.sh`, `.forge/hooks/*.sh`                 | Environment variable injection (`UAM_CONTEXT`, `UAM_OPEN_LOOPS`) |
| **Cursor**         | `.cursor/hooks/session-start.sh` via `hooks.json`                    | `.cursor/hooks.json`, `.cursor/hooks/*.sh`                        | MCP config at `~/.config/Cursor/...`                             |
| **VSCode**         | Uses Claude Code hooks via `.claude/settings.local.json`             | Same as Claude Code                                               | Requires "Third-party skills" enabled                            |
| **Cline**          | Mapped to VSCode hooks                                               | Same as VSCode                                                    | Same as VSCode                                                   |
| **Windsurf**       | Mapped to Cursor hooks                                               | Same as Cursor                                                    | Same as Cursor                                                   |
| **Codex CLI**      | Mapped to Claude hooks                                               | Same as Claude Code                                               | Uses CLAUDE.md context file                                      |
| **Aider**          | Mapped to Claude hooks                                               | Same as Claude Code                                               | Uses CLAUDE.md context file                                      |
| **Zed AI**         | Mapped to Claude hooks                                               | Same as Claude Code                                               | Uses CLAUDE.md context file                                      |
| **Continue**       | Mapped to VSCode hooks                                               | Same as VSCode                                                    | Same as VSCode                                                   |
| **GitHub Copilot** | Mapped to VSCode hooks                                               | Same as VSCode                                                    | Same as VSCode                                                   |
| **JetBrains AI**   | Mapped to VSCode hooks                                               | Same as VSCode                                                    | Same as VSCode                                                   |
| **SWE-agent**      | Mapped to Claude hooks                                               | Same as Claude Code                                               | Uses CLAUDE.md context file                                      |

---

## 6. The UAP Delta

Every harness is a code editing tool with file system and terminal access. UAP transforms them into memory-persistent, coordinated, policy-enforced agent platforms.

| Category         | What UAP Adds                                                                                                            | Why                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **Memory**       | 4-layer persistent memory, write gate, tiering, correction propagation, agent-scoped isolation, daily log, consolidation | Agents learn and retain knowledge across sessions      |
| **Patterns**     | 22 Terminal-Bench patterns, Pattern RAG via Qdrant, reinforcement learning                                               | Proven workflows prevent the most common failure modes |
| **Coordination** | Agent registry, heartbeats, overlap detection, conflict risk, capability routing, work claims                            | Multiple agents collaborate safely on the same repo    |
| **Deployment**   | Intelligent batching, squash commits, push race prevention, parallel execution                                           | Clean deploy history even with many agents             |
| **Policy**       | Required/recommended/optional enforcement, audit trail, IaC state parity                                                 | Agents follow project standards with accountability    |
| **Tasks**        | Dependency DAG, cycle detection, JSONL sync, history/audit, compaction                                                   | Structured work tracking that survives sessions        |
| **Models**       | Multi-model routing (6 presets), task decomposition, plan validation                                                     | Lower cost, better quality per subtask                 |
| **Tooling**      | MCP Router (98% token reduction), RTK (60-90% savings), CloakBrowser, 20+ CLI commands, 6 dashboards                     | Dramatically lower token spend, full observability     |
| **Compliance**   | 12-gate protocol verification                                                                                            | Catches drift before it ships                          |
| **Hooks**        | SessionStart, PreCompact, PreToolUse, PostToolUse across 6 hook targets                                                  | Automated memory injection and preservation            |

---

## 7. Feature Flags

Every UAP feature is individually toggleable via the setup wizard (`uap setup`) or `.uap.json`.

| Category    | Flag                     | Default           | What It Controls                       |
| ----------- | ------------------------ | ----------------- | -------------------------------------- |
| Memory      | `shortTermMemory`        | `true`            | L1/L2 SQLite working + session memory  |
| Memory      | `longTermMemory`         | `false`           | L3 Qdrant vector semantic memory       |
| Memory      | `knowledgeGraph`         | `false`           | L4 entity-relationship graph           |
| Memory      | `prepopDocs`             | `false`           | Import existing docs into memory       |
| Memory      | `prepopGit`              | `false`           | Import git history into memory         |
| Multi-Agent | `coordinationDb`         | `true`            | Agent registry, heartbeats, claims     |
| Multi-Agent | `worktreeIsolation`      | `true`            | Per-agent git worktrees                |
| Multi-Agent | `deployBatching`         | `false`           | Squash + serialize deploys             |
| Multi-Agent | `agentMessaging`         | `false`           | Inter-agent broadcast/direct messages  |
| Patterns    | `patternLibrary`         | `true`            | 22 Terminal-Bench patterns             |
| Patterns    | `patternRag`             | depends on Qdrant | On-demand pattern retrieval            |
| Patterns    | `reinforcementLearning`  | `false`           | Pattern success/failure tracking       |
| Policy      | `policyEngine`           | `true`            | Rule enforcement with audit trail      |
| Policy      | `imageAssetVerification` | `false`           | Image asset policy checks              |
| Policy      | `iacStateParity`         | `true`            | Infrastructure-as-code drift detection |
| Policy      | `customPoliciesDir`      | `false`           | Load policies from custom directory    |
| Model       | `provider`               | `anthropic`       | Default model provider                 |
| Model       | `qwenOptimizations`      | `false`           | Qwen3.5 tool call fixes                |
| Model       | `costTracking`           | `false`           | Per-task cost accounting               |
| Model       | `modelRouting`           | `false`           | Multi-model task routing               |
| Hooks       | `sessionStart`           | `true`            | Memory injection on session start      |
| Hooks       | `preCompact`             | `true`            | Memory preservation before compaction  |
| Hooks       | `taskCompletion`         | `false`           | Post-task hooks                        |
| Hooks       | `autoApproveTools`       | `false`           | Skip tool approval prompts             |
| Browser     | `cloakBrowser`           | `false`           | Stealth web automation                 |

Per-platform overrides are available for `shortTermMax`, `searchResults`, `sessionMax`, and `patternRag` in the `platforms` section of `.uap.json`.

---

**Last Updated:** 2026-03-15 | **Version:** 1.1.0
